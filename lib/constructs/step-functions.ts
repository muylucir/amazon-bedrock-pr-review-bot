import * as cdk from 'aws-cdk-lib';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface ReviewBotStepFunctionsProps {
  functions: { [key: string]: lambda.Function };
  role: iam.IRole;
}

export class ReviewBotStepFunctions extends Construct {
  public readonly stateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: ReviewBotStepFunctionsProps) {
    super(scope, id);

    // Initial Processing Task
    const initialProcessing = new tasks.LambdaInvoke(this, 'InitialProcessing', {
      lambdaFunction: props.functions.initialProcessing,
      inputPath: '$',
      resultPath: '$.processingResult',
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });

    // Split PR into Chunks Task
    const splitPr = new tasks.LambdaInvoke(this, 'SplitPRIntoChunks', {
      lambdaFunction: props.functions.splitPr,
      inputPath: '$.processingResult.body.data',
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });

    // Process Single Chunk Task
    const processSingleChunk = new tasks.LambdaInvoke(this, 'ProcessSingleChunk', {
      lambdaFunction: props.functions.processChunk,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });

    // Process Chunk with error handling
    const processChunk = new tasks.LambdaInvoke(this, 'ProcessChunk', {
      lambdaFunction: props.functions.processChunk,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true
    });

    // Add retry policy for rate limit errors
    processChunk.addRetry({
      errors: ['States.TaskFailed'],
      intervalSeconds: 5,
      maxAttempts: 3,
      backoffRate: 2,
      resultPath: '$.error',
      conditions: [
        {
          errorType: 'RateLimitError',
          errorPath: '$.error.error_type'
        }
      ]
    });

    // Map State for parallel processing
    const processChunks = new stepfunctions.Map(this, 'ProcessChunks', {
      inputPath: '$.body',
      itemsPath: '$.chunks',
      maxConcurrency: 1,
      itemSelector: {
        'body.$': '$'
      },
      resultPath: '$.chunkResults',
      catchErrors: ['States.ALL'],
      resultSelector: {
        'results.$': '$.results',
        'failed.$': '$.failed'
      }
    }).itemProcessor(processChunk);

    // Filter failed chunks
    const filterFailedChunks = new stepfunctions.Pass(this, 'FilterFailedChunks', {
      parameters: {
        'failed_chunks.$': '$.chunkResults[?(@.statusCode != 200)]',
        'successful_chunks.$': '$.chunkResults[?(@.statusCode == 200)]'
      }
    });

    // Check for failed chunks
    const checkFailedChunks = new stepfunctions.Choice(this, 'CheckFailedChunks')
      .when(
        stepfunctions.Condition.isPresent('$.failed_chunks[0]'),
        // Retry only failed chunks
        new stepfunctions.Map(this, 'RetryFailedChunks', {
          maxConcurrency: 1,
          itemsPath: '$.failed_chunks',
          resultPath: '$.retryResults'
        }).itemProcessor(processChunk)
      )
      .otherwise(new stepfunctions.Pass(this, 'NoFailedChunks'));

    // Aggregate Results Task
    const aggregateResults = new tasks.LambdaInvoke(this, 'AggregateResults', {
      lambdaFunction: props.functions.aggregateResults,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });

    // Success State
    const success = new stepfunctions.Succeed(this, 'Success');

    // Failed State
    const failed = new stepfunctions.Fail(this, 'Failed', {
      error: 'WorkflowFailed',
      cause: 'Workflow execution failed'
    });

    // Handle Error Task
    const handleError = new tasks.LambdaInvoke(this, 'HandleError', {
      lambdaFunction: props.functions.handleError,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });

    // Post PR Comment Task
    const postPrComment = new tasks.LambdaInvoke(this, 'PostPRComment', {
      lambdaFunction: props.functions.postPrComment,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });

    // Send Slack Notification Task
    const sendSlackNotification = new tasks.LambdaInvoke(this, 'SendSlackNotification', {
      lambdaFunction: props.functions.sendSlackNotification,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });

    // Post Results in parallel
    const postResults = new stepfunctions.Parallel(this, 'PostResults', {
      resultPath: '$.postResults'
    })
    .branch(new stepfunctions.Chain()
      .start(postPrComment)
      .next(new stepfunctions.Choice(this, 'CheckPRCommentStatus')
        .when(stepfunctions.Condition.numberEquals('$.statusCode', 200),
          new stepfunctions.Pass(this, 'PRCommentSuccess'))
        .otherwise(handleError)))
    .branch(new stepfunctions.Chain()
      .start(sendSlackNotification)
      .next(new stepfunctions.Choice(this, 'CheckSlackNotificationStatus')
        .when(stepfunctions.Condition.numberEquals('$.statusCode', 200),
          new stepfunctions.Pass(this, 'SlackNotificationSuccess'))
        .otherwise(handleError)));

    // Final status check
    const checkFinalStatus = new stepfunctions.Choice(this, 'CheckFinalStatus')
      .when(
        stepfunctions.Condition.and(
          stepfunctions.Condition.isPresent('$.postResults[0].statusCode'),
          stepfunctions.Condition.isPresent('$.postResults[1].statusCode'),
          stepfunctions.Condition.numberEquals('$.postResults[0].statusCode', 200),
          stepfunctions.Condition.numberEquals('$.postResults[1].statusCode', 200)
        ),
        success
      )
      .otherwise(failed);

    // Choice State for Chunk Size Check
    const chunkSizeCheck = new stepfunctions.Choice(this, 'ChunkSizeCheck');

    // Define retry policies
    const defaultRetry = {
      errors: ['States.TaskFailed'],
      interval: cdk.Duration.seconds(3),
      maxAttempts: 2,
      backoffRate: 1.5,
    };

    // Add retry policies to tasks
    [initialProcessing, splitPr, processSingleChunk, 
     aggregateResults, postPrComment, sendSlackNotification, handleError].forEach(task => {
      task.addRetry(defaultRetry);
    });

    // Add error handlers
    initialProcessing.addCatch(handleError, {
      resultPath: '$.error',
    });
    splitPr.addCatch(handleError, {
      resultPath: '$.error',
    });
    processChunks.addCatch(handleError, {
      resultPath: '$.error',
    });
    aggregateResults.addCatch(handleError, {
      resultPath: '$.error',
    });
    postResults.addCatch(handleError, {
      resultPath: '$.error',
    });

    // Configure Choice state transitions
    chunkSizeCheck
      .when(stepfunctions.Condition.numberGreaterThan('$.body.total_files', 5), 
        processChunks
          .next(filterFailedChunks)
          .next(checkFailedChunks))
      .otherwise(processSingleChunk);

    // Create State Machine
    this.stateMachine = new stepfunctions.StateMachine(this, 'PRReviewStateMachine', {
      stateMachineName: 'PR-REVIEWER',
      definitionBody: stepfunctions.DefinitionBody.fromChainable(
        initialProcessing
          .next(splitPr)
          .next(chunkSizeCheck)
          .afterwards()
          .next(aggregateResults)
          .next(postResults)
          .next(checkFinalStatus)
      ),
      role: props.role,
      timeout: cdk.Duration.minutes(30),
      tracingEnabled: true,
      logs: {
        destination: new cdk.aws_logs.LogGroup(this, 'ReviewBotStateMachineLogs', {
          logGroupName: '/aws/vendedlogs/states/pr-reviewer',
          retention: cdk.aws_logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY
        }),
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true
      },
      comment: 'State machine for processing PR reviews using Amazon Bedrock'
    });

    // Add CloudFormation outputs
    this.createOutputs();
  }

  private createOutputs() {
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description: 'State Machine ARN'
    });

    new cdk.CfnOutput(this, 'StateMachineUrl', {
      value: `https://console.aws.amazon.com/states/home?region=${cdk.Stack.of(this).region}#/statemachines/view/${this.stateMachine.stateMachineArn}`,
      description: 'State Machine Console URL'
    });
  }
}
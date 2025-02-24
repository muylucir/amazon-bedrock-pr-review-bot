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

    // Process Chunks - 단순화된 단일 Map 상태 사용 (청크 수에 관계없이)
    const processChunks = new stepfunctions.Map(this, 'ProcessChunks', {
      inputPath: '$.body',
      itemsPath: '$.chunks',
      maxConcurrency: 3, // 동시 처리 수 설정 
      resultPath: '$.processResults',
      // 결과 선택기를 통한 결과 구조화
      resultSelector: {
        'results.$': '$[*]'
      }
    }).itemProcessor(new tasks.LambdaInvoke(this, 'ProcessChunk', {
      lambdaFunction: props.functions.processChunk,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    }));

    // 성공 및 실패한 청크 분류
    const classifyResults = new stepfunctions.Pass(this, 'ClassifyResults', {
      parameters: {
        'succeeded.$': "$.processResults.results[?(@.statusCode == 200)]",
        'failed.$': "$.processResults.results[?(@.statusCode == 500 || @.statusCode == 429 || @.body.error && @.body.error.includes('RATE_LIMIT_ERROR'))]"
      },
      resultPath: '$.classifiedResults'
    });

    // 실패한 청크 재처리를 위한 Choice 상태
    const checkFailedChunks = new stepfunctions.Choice(this, 'CheckFailedChunks')
      .when(
        stepfunctions.Condition.isPresent('$.classifiedResults.failed[0]'),
        new stepfunctions.Wait(this, 'WaitBeforeRetry', {
          time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(2))
        }).next(
          new stepfunctions.Map(this, 'RetryFailedChunks', {
            inputPath: '$.classifiedResults',
            itemsPath: '$.failed',
            maxConcurrency: 1,
            resultPath: '$.retryResults'
          }).itemProcessor(new tasks.LambdaInvoke(this, 'RetryChunk', {
            lambdaFunction: props.functions.processChunk,
            payloadResponseOnly: true,
            retryOnServiceExceptions: true
          }))
        )
      )
      .otherwise(new stepfunctions.Pass(this, 'NoFailedChunks'));

    // 재처리 결과와 원본 성공 결과 병합
    const mergeResults = new stepfunctions.Pass(this, 'MergeResults', {
      parameters: {
        'originalResults.$': '$.classifiedResults.succeeded',
        'retryResults.$': '$.retryResults[*]',
        'allResults.$': "States.ArrayConcat($.classifiedResults.succeeded, $.retryResults[*])"
      },
      resultPath: '$.mergedResults'
    });

    // Aggregate Results Task
    const aggregateResults = new tasks.LambdaInvoke(this, 'AggregateResults', {
      lambdaFunction: props.functions.aggregateResults,
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

    // Handle Error Task
    const handleError = new tasks.LambdaInvoke(this, 'HandleError', {
      lambdaFunction: props.functions.handleError,
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

    // Parallel Post Results
    const postResults = new stepfunctions.Parallel(this, 'PostResults', {
      resultPath: '$.postResults'
    });
    postResults.branch(postPrComment);
    postResults.branch(sendSlackNotification);

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

    // Define retry policies
    const defaultRetry = {
      errors: ['States.TaskFailed'],
      interval: cdk.Duration.seconds(3),
      maxAttempts: 2,
      backoffRate: 1.5,
    };

    // Add retry policies to all Lambda tasks
    [initialProcessing, splitPr, aggregateResults, 
     postPrComment, sendSlackNotification, handleError].forEach(task => {
      task.addRetry(defaultRetry);
    });

    // Create State Machine - 단순화된 워크플로우
    this.stateMachine = new stepfunctions.StateMachine(this, 'PRReviewStateMachine', {
      stateMachineName: 'PR-REVIEWER',
      definitionBody: stepfunctions.DefinitionBody.fromChainable(
        initialProcessing
          .next(splitPr)
          .next(processChunks)
          .next(classifyResults)
          .next(checkFailedChunks)
          .next(mergeResults)
          .next(aggregateResults)
          .next(postResults)
          .next(success)
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
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface ReviewBotApiProps {
  stateMachine: stepfunctions.StateMachine;
}

export class ReviewBotApi extends Construct {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ReviewBotApiProps) {
    super(scope, id);

    // Create log group for API Gateway
    const logGroup = new logs.LogGroup(this, 'ApiGatewayLogs', {
      retention: logs.RetentionDays.ONE_WEEK
    });

    // Create API Gateway
    this.api = new apigateway.RestApi(this, 'ReviewBotApi', {
      restApiName: 'PR Review Bot API',
      endpointConfiguration: {
        types: [apigateway.EndpointType.REGIONAL]
      },
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: false,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true
        })
      }
    });

    // Create IAM role for API Gateway
    const apiRole = new iam.Role(this, 'ApiGatewayRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      description: 'Role for API Gateway to invoke Step Functions',
    });

    // Add permission to invoke Step Functions
    apiRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [props.stateMachine.stateMachineArn],
    }));

    // Create webhook endpoint
    const webhook = this.api.root.addResource('webhook');

    // Add POST method
    webhook.addMethod('POST', new apigateway.Integration({
      type: apigateway.IntegrationType.AWS,
      integrationHttpMethod: 'POST',
      uri: `arn:aws:apigateway:${cdk.Stack.of(this).region}:states:action/StartExecution`,
      options: {
        credentialsRole: apiRole,
        requestTemplates: {
          'application/json': JSON.stringify({
            input: "{\"body\": $util.escapeJavaScript($input.json('$'))}",
            stateMachineArn: props.stateMachine.stateMachineArn
          })
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': JSON.stringify({
                executionArn: "$util.parseJson($input.body).executionArn",
                startDate: "$util.parseJson($input.body).startDate"
              })
            }
          }
        ]
      }
    }), {
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL
          }
        }
      ]
    });

    // Output API URL
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${this.api.url}webhook`,
      description: 'Webhook URL for PR Review Bot',
    });
  }
}
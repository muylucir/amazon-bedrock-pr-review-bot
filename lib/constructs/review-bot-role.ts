import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface ReviewBotRoleProps {
  secrets: { [key: string]: cdk.aws_secretsmanager.ISecret };
  region: string;
  account: string;
}

export class ReviewBotRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: ReviewBotRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, 'ReviewBotLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Shared role for ReviewBot Lambda functions',
      managedPolicies: [
        // Basic Lambda execution permissions
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess'),
      ]
    });

    // Secrets Manager permissions
    this.role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: Object.values(props.secrets).map(secret => secret.secretArn)
    }));

    // SSM Parameter Store permissions
    this.role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath'
      ],
      resources: [
        `arn:aws:ssm:${props.region}:${props.account}:parameter/pr-reviewer/*`
      ]
    }));

    // CloudWatch Logs permissions
    this.role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents'
      ],
      resources: [
        `arn:aws:logs:${props.region}:${props.account}:log-group:/aws/lambda/*`
      ]
    }));

    // CloudWatch Metrics permissions
    this.role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        'StringEquals': {
          'cloudwatch:namespace': 'PRReviewer'
        }
      }
    }));
  }
}
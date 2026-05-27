/**
 * P0 stack — Cognito, JWT authorizer, identity DDB, workspace S3, API Lambda.
 */
const path = require('path');
const cdk = require('aws-cdk-lib');
const cognito = require('aws-cdk-lib/aws-cognito');
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2');
const apigwv2Authorizers = require('aws-cdk-lib/aws-apigatewayv2-authorizers');
const integrations = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const lambda = require('aws-cdk-lib/aws-lambda');
const kms = require('aws-cdk-lib/aws-kms');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const s3 = require('aws-cdk-lib/aws-s3');
const iam = require('aws-cdk-lib/aws-iam');

class P0Stack extends cdk.Stack {
  /** @param {constructs.Construct} scope @param {string} id @param {cdk.StackProps} props */
  constructor(scope, id, props) {
    super(scope, id, props);

    const workspaceKey = new kms.Key(this, 'WorkspaceKey', {
      alias: 'alias/orchard-workspace-dev',
      enableKeyRotation: true,
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'orchard-dev',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 12 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const extensionRedirectUri = this.node.tryGetContext('extensionRedirectUri')
      || 'https://pnihglgmdjgdckddleipneompomedioc.chromiumapp.org/orchard';

    const client = userPool.addClient('ExtensionClient', {
      userPoolClientName: 'ahub-extension',
      generateSecret: false,
      oAuth: {
        flows: { implicitCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [extensionRedirectUri],
        logoutUrls: [extensionRedirectUri],
      },
    });

    const domain = userPool.addDomain('HostedUi', {
      cognitoDomain: { domainPrefix: `orchard-dev-${cdk.Names.uniqueId(this).toLowerCase().slice(0, 8)}` },
    });

    const identityTable = new dynamodb.Table(this, 'OrchardIdentity', {
      tableName: 'orchard-identity-dev',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    const objectTable = new dynamodb.Table(this, 'OrchardObjectIndex', {
      tableName: 'orchard-objects-dev',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    objectTable.addGlobalSecondaryIndex({
      indexName: 'ChangeFeed',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const workspaceBucket = new s3.Bucket(this, 'WorkspaceBucket', {
      bucketName: `dev-orchard-workspace-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: workspaceKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3600,
      }],
    });

    const apiHandler = new lambda.Function(this, 'ApiHandler', {
      functionName: 'orchard-p0-api',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/api')),
      timeout: cdk.Duration.seconds(29),
      environment: {
        IDENTITY_TABLE: identityTable.tableName,
        OBJECT_TABLE: objectTable.tableName,
        WORKSPACE_BUCKET: workspaceBucket.bucketName,
      },
    });

    identityTable.grantReadWriteData(apiHandler);
    objectTable.grantReadWriteData(apiHandler);
    workspaceBucket.grantReadWrite(apiHandler);
    workspaceKey.grantDecrypt(apiHandler);

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'orchard-dev',
      corsPreflight: {
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowOrigins: ['*'],
      },
    });

    const authorizer = new apigwv2Authorizers.HttpJwtAuthorizer('CognitoAuthorizer', `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`, {
      jwtAudience: [client.userPoolClientId],
    });

    const integration = new integrations.HttpLambdaIntegration('ApiIntegration', apiHandler);
    httpApi.addRoutes({
      path: '/v1/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration,
      authorizer,
    });

    new cdk.CfnOutput(this, 'ApiBaseUrl', { value: `${httpApi.apiEndpoint}/v1` });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `https://${domain.domainName}.auth.us-east-1.amazoncognito.com`,
    });
    new cdk.CfnOutput(this, 'WorkspaceKmsKeyArn', { value: workspaceKey.keyArn });
    new cdk.CfnOutput(this, 'WorkspaceBucketName', { value: workspaceBucket.bucketName });
    new cdk.CfnOutput(this, 'IdentityTableName', { value: identityTable.tableName });
    new cdk.CfnOutput(this, 'ObjectTableName', { value: objectTable.tableName });
  }
}

module.exports = { P0Stack };

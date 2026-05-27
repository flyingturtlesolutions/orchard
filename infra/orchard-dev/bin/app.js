#!/usr/bin/env node
/**
 * Orchard dev CDK entry (P0). Deploy to orchard-dev account / us-east-1 (DD-13).
 *
 *   cd infra/orchard-dev && npm install && npx cdk deploy
 */
const cdk = require('aws-cdk-lib');
const { P0Stack } = require('../lib/p0-stack');

const app = new cdk.App();

new P0Stack(app, 'OrchardP0Dev', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Orchard P0: Cognito + HTTP API skeleton (dev)',
});

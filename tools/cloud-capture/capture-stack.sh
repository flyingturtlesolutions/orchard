#!/usr/bin/env bash
# tools/cloud-capture/capture-stack.sh — READ-ONLY capture of the live Orchard AWS stack (CloudShell, us-east-1).
#
# Paste this whole file into AWS CloudShell (us-east-1) and press Enter. It creates ~/orchard-capture/,
# reads back the deployed configuration + Lambda code bundles, and zips everything into
# ~/orchard-capture.zip for download (CloudShell: Actions → Download file → orchard-capture.zip).
#
# GUARANTEES:
#   · Read-only: every AWS call is a get/list/describe. Nothing is created, modified, or deleted.
#   · No secret VALUES: Secrets Manager is listed by name only; Cognito client secrets and Lambda
#     environment variables with secret-looking names are REDACTED before they touch disk.
#   · Fail-soft: a missing permission skips that section and moves on (check _errors.log afterwards).
#
# Purpose: bootstrap the orchard-cloud infra repo from the running system (AWS_INTEGRATION.md §10;
# DESIGN_cloud_logs.md CW-1/CW-2 need this baseline). The deploy blueprint never existed locally —
# the stack was built from CloudShell — so the running stack IS the source of truth to capture.

set -u
REGION="${AWS_REGION:-us-east-1}"
OUT="$HOME/orchard-capture"
ERR="$OUT/_errors.log"
mkdir -p "$OUT"/{apigw,lambda/functions,iam,dynamodb,cognito,s3,kms,secrets,logs}
: > "$ERR"

say() { echo "== $*"; }
run() { # run <outfile> <aws args...>
  local out="$1"; shift
  aws "$@" --region "$REGION" --output json > "$out" 2>>"$ERR" || { echo "FAILED: aws $*" >> "$ERR"; rm -f "$out"; }
}

REDACT_ENV='if .Environment.Variables? then .Environment.Variables |= with_entries(if (.key|test("(?i)secret|token|passw|api_?key|private")) then .value = "**REDACTED**" else . end) else . end'

say "identity + region"
run "$OUT/caller-identity.json" sts get-caller-identity
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$OUT/captured-at.txt"; echo "$REGION" >> "$OUT/captured-at.txt"

say "CloudShell home inventory (your original deploy files may still be here!)"
ls -la "$HOME" > "$OUT/home-inventory.txt" 2>>"$ERR"
find "$HOME" -maxdepth 3 -not -path "$OUT*" -not -path "*/.cache/*" -not -path "*/.npm/*" 2>>"$ERR" | head -400 >> "$OUT/home-inventory.txt"

say "API Gateway (HTTP APIs): apis, routes, integrations, authorizers, stages"
run "$OUT/apigw/apis.json" apigatewayv2 get-apis
for API_ID in $(jq -r '.Items[].ApiId' "$OUT/apigw/apis.json" 2>/dev/null); do
  run "$OUT/apigw/$API_ID-api.json"          apigatewayv2 get-api          --api-id "$API_ID"
  run "$OUT/apigw/$API_ID-routes.json"       apigatewayv2 get-routes       --api-id "$API_ID" --max-results 200
  run "$OUT/apigw/$API_ID-integrations.json" apigatewayv2 get-integrations --api-id "$API_ID" --max-results 200
  run "$OUT/apigw/$API_ID-authorizers.json"  apigatewayv2 get-authorizers  --api-id "$API_ID"
  run "$OUT/apigw/$API_ID-stages.json"       apigatewayv2 get-stages       --api-id "$API_ID"
done

say "Lambda: configurations (env redacted), resource policies, and CODE BUNDLES"
run "$OUT/lambda/functions.json" lambda list-functions --max-items 100
for FN in $(jq -r '.Functions[].FunctionName' "$OUT/lambda/functions.json" 2>/dev/null); do
  aws lambda get-function-configuration --function-name "$FN" --region "$REGION" --output json 2>>"$ERR" \
    | jq "$REDACT_ENV" > "$OUT/lambda/$FN-config.json" 2>>"$ERR"
  aws lambda get-policy --function-name "$FN" --region "$REGION" --output json > "$OUT/lambda/$FN-policy.json" 2>>"$ERR" || rm -f "$OUT/lambda/$FN-policy.json"
  CODE_URL=$(aws lambda get-function --function-name "$FN" --region "$REGION" --query 'Code.Location' --output text 2>>"$ERR")
  [ -n "${CODE_URL:-}" ] && [ "$CODE_URL" != "None" ] && curl -sL -o "$OUT/lambda/functions/$FN.zip" "$CODE_URL" 2>>"$ERR"
done

say "IAM: the Lambdas' execution roles (attached + inline policies)"
for ROLE_ARN in $(jq -r '.Functions[].Role' "$OUT/lambda/functions.json" 2>/dev/null | sort -u); do
  R="${ROLE_ARN##*/}"
  run "$OUT/iam/$R-role.json"     iam get-role --role-name "$R"
  run "$OUT/iam/$R-attached.json" iam list-attached-role-policies --role-name "$R"
  run "$OUT/iam/$R-inline.json"   iam list-role-policies --role-name "$R"
  for P in $(jq -r '.PolicyNames[]?' "$OUT/iam/$R-inline.json" 2>/dev/null); do
    run "$OUT/iam/$R-inline-$P.json" iam get-role-policy --role-name "$R" --policy-name "$P"
  done
done

say "DynamoDB: table definitions (schema only — never data)"
run "$OUT/dynamodb/tables.json" dynamodb list-tables
for T in $(jq -r '.TableNames[]' "$OUT/dynamodb/tables.json" 2>/dev/null); do
  run "$OUT/dynamodb/$T-describe.json" dynamodb describe-table --table-name "$T"
  run "$OUT/dynamodb/$T-ttl.json"      dynamodb describe-time-to-live --table-name "$T"
done

say "Cognito: user pools + app clients (client secrets redacted)"
run "$OUT/cognito/pools.json" cognito-idp list-user-pools --max-results 20
for POOL in $(jq -r '.UserPools[].Id' "$OUT/cognito/pools.json" 2>/dev/null); do
  run "$OUT/cognito/$POOL-pool.json" cognito-idp describe-user-pool --user-pool-id "$POOL"
  run "$OUT/cognito/$POOL-clients.json" cognito-idp list-user-pool-clients --user-pool-id "$POOL" --max-results 20
  for C in $(jq -r '.UserPoolClients[].ClientId' "$OUT/cognito/$POOL-clients.json" 2>/dev/null); do
    aws cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$C" --region "$REGION" --output json 2>>"$ERR" \
      | jq 'del(.UserPoolClient.ClientSecret)' > "$OUT/cognito/$POOL-client-$C.json" 2>>"$ERR"
  done
done

say "S3: bucket list; config for orchard-looking buckets"
run "$OUT/s3/buckets.json" s3api list-buckets
for B in $(jq -r '.Buckets[].Name' "$OUT/s3/buckets.json" 2>/dev/null | grep -Ei 'orchard|ahub' ); do
  run "$OUT/s3/$B-encryption.json" s3api get-bucket-encryption --bucket "$B"
  run "$OUT/s3/$B-versioning.json" s3api get-bucket-versioning --bucket "$B"
  run "$OUT/s3/$B-policy.json"     s3api get-bucket-policy     --bucket "$B"
  run "$OUT/s3/$B-lifecycle.json"  s3api get-bucket-lifecycle-configuration --bucket "$B"
done

say "KMS aliases · Secrets Manager NAMES ONLY · existing CloudWatch log groups"
run "$OUT/kms/aliases.json" kms list-aliases
aws secretsmanager list-secrets --region "$REGION" --output json 2>>"$ERR" \
  | jq '[.SecretList[]? | {Name, ARN, LastChangedDate}]' > "$OUT/secrets/names-only.json" 2>>"$ERR"
run "$OUT/logs/log-groups.json" logs describe-log-groups --limit 50

say "zipping"
( cd "$HOME" && rm -f orchard-capture.zip && zip -rq orchard-capture.zip "$(basename "$OUT")" )
echo ""
echo "DONE → download it via CloudShell: Actions → Download file → orchard-capture.zip"
echo "Errors/skips (usually just missing permissions): $(wc -l < "$ERR") line(s) in _errors.log"

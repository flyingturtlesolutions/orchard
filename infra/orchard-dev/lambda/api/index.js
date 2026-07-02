/**
 * Orchard P0/P1 API — identity, object CRUD, batch writes, change feed.
 */
const crypto = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { invokeMcpTool, listMcpTools, MCP_ENDPOINTS } = require('./mcp.cjs');   // MP-2b (CX-5b §5.2) — the MCP transport; MP-2c — live tools/list discovery
const { exchangeAuthCode, refreshAccessToken, CONNECTOR_TOKEN_URLS } = require('./oauth.cjs');   // MP-3b — code→token exchange + refresh (client secret lives HERE only)
const { invokeGoogleRestTool } = require('./googleRest.cjs');   // v1318 — the GA REST channel for Google (its MCP servers are Developer-Preview-gated; consumer accounts can't enroll)

const IDENTITY_TABLE = process.env.IDENTITY_TABLE;
const OBJECT_TABLE = process.env.OBJECT_TABLE;
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET;
const PUBLICATIONS_TABLE = process.env.PUBLICATIONS_TABLE;
const PUBLICATIONS_BUCKET = process.env.PUBLICATIONS_BUCKET;
const SHARED_WS_TABLE = process.env.SHARED_WS_TABLE;
const REGISTRY_ID = 'orchard-public';   // v1 single registry (DD-16)
const MAX_BATCH = 10;
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 };   // shared-workspace roles (§6.2)

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sm = new SecretsManagerClient({});
const ANTHROPIC_SECRET_ARN = process.env.ANTHROPIC_SECRET_ARN;
let _anthropicKeyCache = null;   // cached across warm invocations

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function routePath(event) {
  return (event.requestContext?.http?.path || '').replace(/^\/v1/, '') || '/';
}

function jwtClaims(event) {
  return event.requestContext?.authorizer?.jwt?.claims || {};
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlToBuf(s) {
  return Buffer.from(s, 'base64url');
}

function deriveOrchardUserId(publicKeyRaw) {
  const hash = crypto.createHash('sha256').update(publicKeyRaw).digest();
  return `pk_${hash.toString('base64url').slice(0, 22)}`;
}

function importEd25519PublicKey(raw32) {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, raw32]),
    format: 'der',
    type: 'spki',
  });
}

function verifyEd25519(publicKeyB64, messageBytes, signatureB64) {
  const key = importEd25519PublicKey(b64urlToBuf(publicKeyB64));
  return crypto.verify(null, messageBytes, key, b64urlToBuf(signatureB64));
}

function pathHash(logicalPath) {
  return crypto.createHash('sha256').update(logicalPath).digest('hex').slice(0, 12);
}

function gsi2Sk(updatedAt, logicalPath) {
  return `TS#${String(updatedAt).padStart(13, '0')}#${pathHash(logicalPath)}`;
}

function isPathDenied(logicalPath) {
  if (!logicalPath || logicalPath.includes('..')) return true;
  if (logicalPath.startsWith('refs/')) return true;
  if (logicalPath.startsWith('runtime/')) return true;
  if (logicalPath.includes('_userPrivate')) return true;
  if (logicalPath.includes('/private/')) return true;
  if (logicalPath === 'meta/deviceId.json') return true;
  return false;
}

function extractGroundId(logicalPath) {
  const m = logicalPath.match(/^workspace\/grounds\/([^/]+)/);
  return m ? m[1] : null;
}

function extractPrimitiveType(logicalPath) {
  if (logicalPath.endsWith('/ground.json')) return 'ground';
  if (logicalPath.includes('/tier1/fragments/')) return 'fragment';
  if (logicalPath.includes('/tier1/observations/')) return 'observation';
  if (logicalPath.includes('/tier1/analyses/')) return 'analysis';
  if (logicalPath.includes('/tier1/assertions/')) return 'assertion';
  if (logicalPath.includes('/workflows/')) return 'workflow';
  if (logicalPath.includes('/perspectives/')) return 'perspective';
  if (logicalPath.includes('/substrate/landmarks/')) return 'landmark';
  if (logicalPath.includes('/strategies/')) return 'strategy';
  if (logicalPath.includes('/locales/')) return 'locale';
  if (logicalPath.endsWith('/siteMap.json')) return 'siteMap';
  if (logicalPath.endsWith('/chrome.json')) return 'chrome';
  if (logicalPath.endsWith('/_manifest.json')) return 'manifest';
  return 'object';
}

function tierForPath(logicalPath) {
  if (logicalPath.includes('/workflows/') && logicalPath.endsWith('.json') && !logicalPath.endsWith('/_manifest.json')) {
    return 2;
  }
  if (logicalPath.includes('workspace/strategies/')) return 3;
  if (logicalPath.endsWith('/ground.json') || logicalPath.endsWith('/siteMap.json') || logicalPath.endsWith('/chrome.json')) return 2;
  if (logicalPath.includes('/intents/')) return 2;
  return 1;
}

function conflictResolution(logicalPath, clientEnvelope, serverEnvelope) {
  const tier = tierForPath(logicalPath);
  if (tier >= 2 || logicalPath.endsWith('/_manifest.json')) {
    return {
      resolution: 'manual-required',
      suggestedAction: 'open-merge',
    };
  }
  if (clientEnvelope?.updatedAt > serverEnvelope?.updatedAt) {
    return {
      resolution: 'auto-lww-allowed',
      suggestedAction: 'keep-mine',
    };
  }
  return {
    resolution: 'manual-required',
    suggestedAction: 'keep-theirs',
  };
}

async function getIdentityRecord(cognitoSub) {
  const res = await ddb.send(new GetCommand({
    TableName: IDENTITY_TABLE,
    Key: { PK: `COGNITO#${cognitoSub}` },
  }));
  return res.Item || null;
}

async function requireOrchardUser(event) {
  const claims = jwtClaims(event);
  const sub = claims.sub;
  if (!sub) return { error: json(401, { error: 'unauthorized' }) };
  const record = await getIdentityRecord(sub);
  if (!record?.orchardUserId) {
    return { error: json(403, { error: 'identity_not_bound' }) };
  }
  return { orchardUserId: record.orchardUserId, claims };
}

// Object storage is namespaced by a `scope`: personal (`users/{orchardUserId}/` + DDB PK
// `USER#{id}`) or team (`shared-workspaces/{wsId}/` + DDB PK `WS#{wsId}`, DD-05 C). All object
// helpers below take a scope so the same code path serves both; handlers build the scope after
// resolving auth (personal) or workspace role (team).
/** @typedef {{ s3Prefix: string, ddbId: string }} Scope */
/** @param {string} orchardUserId @returns {Scope} */
function userScope(orchardUserId) { return { s3Prefix: `users/${orchardUserId}/`, ddbId: `USER#${orchardUserId}` }; }
/** @param {string} wsId @returns {Scope} */
function workspaceScope(wsId) { return { s3Prefix: `shared-workspaces/${wsId}/`, ddbId: `WS#${wsId}` }; }

function objectKeys(scope, logicalPath) {
  return { PK: scope.ddbId, SK: `PATH#${logicalPath}` };
}

async function getIndexRecord(scope, logicalPath) {
  const res = await ddb.send(new GetCommand({
    TableName: OBJECT_TABLE,
    Key: objectKeys(scope, logicalPath),
  }));
  return res.Item || null;
}

async function removeIndexRecord(scope, logicalPath) {
  await ddb.send(new DeleteCommand({
    TableName: OBJECT_TABLE,
    Key: objectKeys(scope, logicalPath),
  }));
}

/** @returns {Promise<boolean>} */
async function s3ObjectExists(scope, logicalPath) {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: s3Key(scope, logicalPath),
    }));
    return true;
  } catch {
    return false;
  }
}

function s3Key(scope, logicalPath) {
  return `${scope.s3Prefix}${logicalPath}`;
}

function stagingS3Key(scope, uploadId) {
  return `${scope.s3Prefix}_staging/${uploadId}`;
}

const PRESIGN_TTL_SECONDS = 900;
const INLINE_OBJECT_MAX_BYTES = 256 * 1024;
// Hard cap on the raw request body, checked before any JSON.parse — bounds the cost/DoS surface
// (S3 PUT + KMS + DDB per write). Generous enough for a full /objects/batch, well under the
// API Gateway 10 MB ceiling.
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

function normalizeEtag(etag) {
  if (!etag) return null;
  return etag.replace(/^"|"$/g, '');
}

function parseIfMatch(event) {
  const raw = event.headers?.['if-match'] || event.headers?.['If-Match'] || '*';
  return raw === '*' ? '*' : normalizeEtag(raw);
}

async function handleIdentityMe(event) {
  const claims = jwtClaims(event);
  const sub = claims.sub;
  if (!sub) return json(401, { error: 'unauthorized' });

  const record = await getIdentityRecord(sub);
  return json(200, {
    cognitoSub: sub,
    email: claims.email || null,
    orchardUserId: record?.orchardUserId || null,
    bound: !!record?.orchardUserId,
    publicKey: record?.publicKey || null,
  });
}

async function handleBindChallenge(event) {
  const claims = jwtClaims(event);
  const sub = claims.sub;
  if (!sub) return json(401, { error: 'unauthorized' });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const { publicKey } = body;
  if (!publicKey || typeof publicKey !== 'string') {
    return json(400, { error: 'publicKey required' });
  }

  const challenge = b64url(crypto.randomBytes(32));
  const ttl = Math.floor(Date.now() / 1000) + 300;

  await ddb.send(new PutCommand({
    TableName: IDENTITY_TABLE,
    Item: {
      PK: `CHALLENGE#${sub}`,
      challenge,
      publicKey,
      ttl,
    },
  }));

  return json(200, { challenge });
}

async function handleBind(event) {
  const claims = jwtClaims(event);
  const sub = claims.sub;
  if (!sub) return json(401, { error: 'unauthorized' });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const { publicKey, challenge, signature } = body;
  if (!publicKey || !challenge || !signature) {
    return json(400, { error: 'publicKey, challenge, signature required' });
  }

  const pending = await ddb.send(new GetCommand({
    TableName: IDENTITY_TABLE,
    Key: { PK: `CHALLENGE#${sub}` },
  }));

  const pendingItem = pending.Item;
  if (!pendingItem || pendingItem.challenge !== challenge || pendingItem.publicKey !== publicKey) {
    return json(409, { error: 'invalid_challenge' });
  }

  const challengeBytes = b64urlToBuf(challenge);
  if (!verifyEd25519(publicKey, challengeBytes, signature)) {
    return json(401, { error: 'invalid_signature' });
  }

  const existing = await getIdentityRecord(sub);
  // One workspace per Cognito account — additional devices reuse the same
  // orchardUserId instead of deriving a new pk_* namespace from each keypair.
  const orchardUserId = existing?.orchardUserId
    ?? deriveOrchardUserId(b64urlToBuf(publicKey));
  const devicePublicKeys = Array.isArray(existing?.devicePublicKeys)
    ? [...existing.devicePublicKeys]
    : (existing?.publicKey ? [existing.publicKey] : []);
  if (!devicePublicKeys.includes(publicKey)) {
    devicePublicKeys.push(publicKey);
  }
  const now = Date.now();

  await ddb.send(new PutCommand({
    TableName: IDENTITY_TABLE,
    Item: {
      PK: `COGNITO#${sub}`,
      orchardUserId,
      publicKey,
      devicePublicKeys,
      email: claims.email || null,
      boundAt: existing?.boundAt || now,
      lastBoundAt: now,
    },
  }));

  await ddb.send(new DeleteCommand({
    TableName: IDENTITY_TABLE,
    Key: { PK: `CHALLENGE#${sub}` },
  }));

  return json(200, { orchardUserId, boundAt: now });
}

async function resolveObjectSizeBytes(scope, logicalPath, index) {
  if (typeof index?.sizeBytes === 'number' && index.sizeBytes > 0) {
    return index.sizeBytes;
  }
  try {
    const head = await s3.send(new HeadObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: s3Key(scope, logicalPath),
    }));
    return head.ContentLength || 0;
  } catch {
    return 0;
  }
}

async function presignedGetUrl(scope, logicalPath) {
  const command = new GetObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: s3Key(scope, logicalPath),
  });
  return getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL_SECONDS });
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

/**
 * Resolve a URL-routed object path to the form actually stored. Writes persist `body.path` (raw,
 * single-encoded — locale keys legitimately contain %3A/%2F as one segment); reads route via the
 * URL, where API Gateway's %-decoding may leave the path raw or over-decoded. Try the as-given form
 * first (matches writes), then a single decodeURIComponent fallback, picking whichever has a stored
 * index row. Cannot regress plain ids (raw === decoded); fixes encoded keys (locales).
 * @returns {Promise<{ logicalPath: string, index: object|null }>}
 */
async function resolveObjectPath(scope, rawFromUrl) {
  const candidates = [rawFromUrl];
  try {
    const decoded = decodeURIComponent(rawFromUrl);
    if (decoded !== rawFromUrl) candidates.push(decoded);
  } catch { /* malformed % sequence → only the raw form is usable */ }
  for (const candidate of candidates) {
    const index = await getIndexRecord(scope, candidate);
    if (index) return { logicalPath: candidate, index };
  }
  return { logicalPath: candidates[0], index: null };
}

async function getObjectInScope(scope, rawPath) {
  if (!rawPath || isPathDenied(rawPath) || isPathDenied(safeDecode(rawPath))) {
    return json(rawPath ? 403 : 400, { error: rawPath ? 'path_denied' : 'invalid_path' });
  }
  const { logicalPath, index } = await resolveObjectPath(scope, rawPath);

  if (index?.deleted) {
    return json(404, { error: 'not_found', path: logicalPath });
  }

  const key = s3Key(scope, logicalPath);
  if (index && !(await s3ObjectExists(scope, logicalPath))) {
    await removeIndexRecord(scope, logicalPath);
    return json(404, { error: 'not_found', path: logicalPath, orphan: true });
  }

  const sizeBytes = await resolveObjectSizeBytes(scope, logicalPath, index);

  if (sizeBytes > INLINE_OBJECT_MAX_BYTES) {
    const downloadUrl = await presignedGetUrl(scope, logicalPath);
    const etag = normalizeEtag(index?.etag || '');
    return {
      statusCode: 302,
      headers: {
        location: downloadUrl,
        ...(etag ? { 'x-orchard-etag': etag } : {}),
        'x-orchard-size-bytes': String(sizeBytes),
        'access-control-expose-headers': 'location, x-orchard-etag, x-orchard-size-bytes',
      },
      body: '',
    };
  }

  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: key,
    }));
    const body = await obj.Body.transformToString();
    return {
      statusCode: 200,
      headers: {
        'content-type': obj.ContentType || 'application/json',
        etag: obj.ETag || '',
      },
      body,
    };
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return json(404, { error: 'not_found', path: logicalPath });
    }
    throw e;
  }
}

async function handleGetObject(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const rawPath = routePath(event).replace(/^\/objects\/?/, '');
  return getObjectInScope(userScope(auth.orchardUserId), rawPath);
}

async function listObjectsInScope(scope, since, limit) {
  const params = {
    TableName: OBJECT_TABLE,
    IndexName: 'ChangeFeed',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': scope.ddbId },
    Limit: limit,
    ScanIndexForward: true,
  };
  if (since) {
    params.KeyConditionExpression += ' AND GSI2SK > :since';
    params.ExpressionAttributeValues[':since'] = since;
  }
  const res = await ddb.send(new QueryCommand(params));
  const changes = (res.Items || []).map((item) => ({
    path: item.path,
    etag: item.etag,
    updatedAt: item.updatedAt,
    groundId: item.groundId || null,
    primitiveType: item.primitiveType || null,
    deleted: item.deleted === true,
  }));
  const nextToken = changes.length > 0 ? res.Items[res.Items.length - 1].GSI2SK : since;
  return json(200, { changes, nextToken });
}

async function handleListObjects(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const since = event.queryStringParameters?.since || '';
  const limit = Math.min(Number(event.queryStringParameters?.limit || '100'), 500);
  return listObjectsInScope(userScope(auth.orchardUserId), since, limit);
}

async function checkEtagConflict(scope, logicalPath, expectedEtag, clientEnvelope = null) {
  if (expectedEtag === '*') return null;

  const existing = await getIndexRecord(scope, logicalPath);
  const serverEtag = existing?.etag || null;
  if (!serverEtag || normalizeEtag(expectedEtag) === normalizeEtag(serverEtag)) {
    return null;
  }

  let serverBody = null;
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: s3Key(scope, logicalPath),
    }));
    serverBody = JSON.parse(await obj.Body.transformToString());
  } catch {
    serverBody = null;
  }

  const meta = conflictResolution(logicalPath, clientEnvelope || {}, serverBody);
  return json(409, {
    error: 'conflict',
    path: logicalPath,
    server: serverBody,
    serverEtag: normalizeEtag(serverEtag),   // let the client cache the real etag on keep-theirs
    client: clientEnvelope,
    ...meta,
  });
}

async function registerObjectIndex(scope, logicalPath, envelope, etag, sizeBytes, s3VersionId = null) {
  const updatedAt = envelope.updatedAt || Date.now();
  const indexItem = {
    ...objectKeys(scope, logicalPath),
    GSI2PK: scope.ddbId,
    GSI2SK: gsi2Sk(updatedAt, logicalPath),
    path: logicalPath,
    groundId: extractGroundId(logicalPath),
    primitiveType: extractPrimitiveType(logicalPath),
    schemaVersion: envelope.schemaVersion || 1,
    updatedAt,
    etag,
    sizeBytes,
    lifecycle: envelope.lifecycle || 'active',
    s3VersionId,
    deleted: false,
  };

  await ddb.send(new PutCommand({
    TableName: OBJECT_TABLE,
    Item: indexItem,
  }));

  return { path: logicalPath, etag, updatedAt };
}

async function writeOneObject(scope, item) {
  const { path: logicalPath, envelope } = item;
  const expectedEtag = item.expectedEtag ?? '*';

  if (!logicalPath || !envelope || isPathDenied(logicalPath)) {
    return { error: json(400, { error: 'invalid_item', path: logicalPath }) };
  }

  const conflict = await checkEtagConflict(scope, logicalPath, expectedEtag, envelope);
  if (conflict) return { conflict };

  const bodyStr = JSON.stringify(envelope);
  const putRes = await s3.send(new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: s3Key(scope, logicalPath),
    Body: bodyStr,
    ContentType: 'application/json',
  }));

  const etag = normalizeEtag(putRes.ETag || crypto.createHash('md5').update(bodyStr).digest('hex'));
  return registerObjectIndex(
    scope,
    logicalPath,
    envelope,
    etag,
    Buffer.byteLength(bodyStr),
    putRes.VersionId || null,
  );
}

async function handlePresignPut(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const logicalPath = body.path;
  if (!logicalPath || isPathDenied(logicalPath)) {
    return json(logicalPath ? 403 : 400, { error: logicalPath ? 'path_denied' : 'invalid_path' });
  }

  const scope = userScope(auth.orchardUserId);
  const expectedEtag = body.expectedEtag ?? '*';
  const conflict = await checkEtagConflict(scope, logicalPath, expectedEtag);
  if (conflict) return conflict;

  const uploadId = crypto.randomUUID();
  const stagingKey = stagingS3Key(scope, uploadId);
  const command = new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: stagingKey,
    ContentType: 'application/json',
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL_SECONDS });

  return json(200, {
    uploadUrl,
    uploadId,
    path: logicalPath,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    expiresIn: PRESIGN_TTL_SECONDS,
  });
}

async function handleCompletePut(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const logicalPath = body.path;
  const uploadId = body.uploadId;
  if (!logicalPath || !uploadId || isPathDenied(logicalPath)) {
    return json(400, { error: 'path_and_uploadId_required' });
  }

  const scope = userScope(auth.orchardUserId);
  const expectedEtag = body.expectedEtag ?? '*';
  const stagingKey = stagingS3Key(scope, uploadId);
  const finalKey = s3Key(scope, logicalPath);

  try {
    await s3.send(new HeadObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: stagingKey,
    }));
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      return json(404, { error: 'upload_not_found', path: logicalPath, uploadId });
    }
    throw e;
  }

  let envelope;
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: stagingKey,
    }));
    envelope = JSON.parse(await obj.Body.transformToString());
  } catch {
    return json(400, { error: 'invalid_upload_body', path: logicalPath });
  }

  const conflict = await checkEtagConflict(scope, logicalPath, expectedEtag, envelope);
  if (conflict) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: WORKSPACE_BUCKET, Key: stagingKey }));
    } catch { /* best effort */ }
    return conflict;
  }

  const bodyStr = JSON.stringify(envelope);
  const putRes = await s3.send(new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: finalKey,
    Body: bodyStr,
    ContentType: 'application/json',
  }));

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: WORKSPACE_BUCKET, Key: stagingKey }));
  } catch { /* best effort */ }

  const etag = normalizeEtag(putRes.ETag || crypto.createHash('md5').update(bodyStr).digest('hex'));
  const result = await registerObjectIndex(
    scope,
    logicalPath,
    envelope,
    etag,
    Buffer.byteLength(bodyStr),
    putRes.VersionId || null,
  );

  return json(200, { path: result.path, etag: result.etag, updatedAt: result.updatedAt });
}

async function putObjectInScope(scope, logicalPath, envelope, expectedEtag) {
  if (!logicalPath || isPathDenied(logicalPath)) {
    return json(logicalPath ? 403 : 400, { error: logicalPath ? 'path_denied' : 'invalid_path' });
  }
  if (!envelope) return json(400, { error: 'envelope required' });
  const result = await writeOneObject(scope, { path: logicalPath, envelope, expectedEtag });
  if (result.conflict) return result.conflict;
  if (result.error) return result.error;
  return json(200, { path: result.path, etag: result.etag, updatedAt: result.updatedAt });
}

async function handlePutObject(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const logicalPath = decodeURIComponent(routePath(event).replace(/^\/objects\/?/, ''));
  let envelope;
  try {
    envelope = event.body ? JSON.parse(event.body) : null;
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  return putObjectInScope(userScope(auth.orchardUserId), logicalPath, envelope, parseIfMatch(event));
}

async function deleteObjectInScope(scope, rawPath) {
  if (!rawPath || isPathDenied(rawPath) || isPathDenied(safeDecode(rawPath))) {
    return json(rawPath ? 403 : 400, { error: rawPath ? 'path_denied' : 'invalid_path' });
  }
  // Resolve to the stored key form (encoding-tolerant) so a locale delete targets the right object.
  const { logicalPath, index: existing } = await resolveObjectPath(scope, rawPath);
  const updatedAt = Math.max(Date.now(), (existing?.updatedAt || 0) + 1);

  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: s3Key(scope, logicalPath),
    }));
  } catch (e) {
    if (e.name !== 'NoSuchKey' && e.$metadata?.httpStatusCode !== 404) throw e;
  }

  await ddb.send(new PutCommand({
    TableName: OBJECT_TABLE,
    Item: {
      ...objectKeys(scope, logicalPath),
      GSI2PK: scope.ddbId,
      GSI2SK: gsi2Sk(updatedAt, logicalPath),
      path: logicalPath,
      groundId: extractGroundId(logicalPath),
      primitiveType: extractPrimitiveType(logicalPath),
      updatedAt,
      deleted: true,
      etag: existing?.etag || null,
    },
  }));

  return json(200, { deleted: true, path: logicalPath, updatedAt });
}

async function handleDeleteObject(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const rawPath = routePath(event).replace(/^\/objects\/?/, '');
  return deleteObjectInScope(userScope(auth.orchardUserId), rawPath);
}

async function batchWriteInScope(scope, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return json(400, { error: 'items array required' });
  }
  if (items.length > MAX_BATCH) {
    return json(400, { error: 'batch_too_large', max: MAX_BATCH });
  }

  for (const item of items) {
    if (isPathDenied(item.path)) {
      return json(403, { error: 'path_denied', path: item.path });
    }
  }

  // Pre-check all etags (all-or-nothing)
  for (const item of items) {
    const expectedEtag = item.expectedEtag ?? '*';
    const existing = await getIndexRecord(scope, item.path);
    const serverEtag = existing?.etag || null;
    if (expectedEtag !== '*' && serverEtag && normalizeEtag(expectedEtag) !== normalizeEtag(serverEtag)) {
      let serverBody = null;
      try {
        const obj = await s3.send(new GetObjectCommand({
          Bucket: WORKSPACE_BUCKET,
          Key: s3Key(scope, item.path),
        }));
        serverBody = JSON.parse(await obj.Body.transformToString());
      } catch {
        serverBody = null;
      }
      const meta = conflictResolution(item.path, item.envelope, serverBody);
      return json(409, {
        error: 'conflict',
        path: item.path,
        server: serverBody,
        serverEtag: normalizeEtag(serverEtag),   // let the client cache the real etag on keep-theirs
        client: item.envelope,
        ...meta,
      });
    }
  }

  const written = [];
  const s3KeysWritten = [];

  try {
    for (const item of items) {
      const result = await writeOneObject(scope, item);
      if (result.conflict) {
        throw Object.assign(new Error('conflict'), { response: result.conflict });
      }
      if (result.error) {
        throw Object.assign(new Error('write_failed'), { response: result.error });
      }
      written.push(result);
      s3KeysWritten.push(s3Key(scope, item.path));
    }
  } catch (e) {
    for (const key of s3KeysWritten) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: WORKSPACE_BUCKET, Key: key }));
      } catch { /* best effort rollback */ }
    }
    if (e.response) return e.response;
    throw e;
  }

  const etags = Object.fromEntries(written.map((w) => [w.path, w.etag]));
  const updatedAt = Math.max(...written.map((w) => w.updatedAt));

  return json(200, { etags, updatedAt, count: written.length });
}

async function handleBatchWrite(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  return batchWriteInScope(userScope(auth.orchardUserId), body.items);
}

// ── Publication registry (STORAGE_SCHEMA §9 / AWS_INTEGRATION §5.2, §6.4, §7.4) ────────
function pubPrefix(publicationId) {
  return `registries/${REGISTRY_ID}/pub/${publicationId}/`;
}

async function s3PutJson(bucket, key, obj) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: 'application/json', Body: JSON.stringify(obj),
  }));
}

async function s3GetJson(bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await res.Body.transformToString());
  } catch { return null; }
}

async function getPublicationRow(publicationId) {
  const res = await ddb.send(new GetCommand({
    TableName: PUBLICATIONS_TABLE,
    Key: { PK: `REGISTRY#${REGISTRY_ID}`, SK: `PUB#${publicationId}` },
  }));
  return res.Item || null;
}

async function handlePublishPublication(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid_json' }); }
  const { publication, manifest, packages } = payload;
  if (!publication?.publicationId || !manifest || !packages) {
    return json(400, { error: 'missing_publication_manifest_or_packages' });
  }
  const publicationId = String(publication.publicationId);

  // Anti-impersonation: the signer's public key must be one of the caller's bound device keys
  // (DD-01). The bind handler tracks every device key in `devicePublicKeys`; fall back to the
  // single `publicKey` for identities bound before that field existed.
  const identity = await getIdentityRecord(auth.claims.sub);
  const signerKey = publication.publishedBy && publication.publishedBy.publicKey;
  const boundKeys = Array.isArray(identity?.devicePublicKeys) && identity.devicePublicKeys.length
    ? identity.devicePublicKeys
    : (identity?.publicKey ? [identity.publicKey] : []);
  if (!signerKey || (boundKeys.length && !boundKeys.includes(signerKey))) {
    return json(403, { error: 'publisher_key_mismatch' });
  }
  if (!publication.signature) return json(400, { error: 'unsigned_publication' });

  // Immutable per version (DD-12 B): a publicationId is written once.
  if (await getPublicationRow(publicationId)) return json(409, { error: 'already_published', publicationId });

  // Lineage root (DD-12 B): inherit from previousVersionId, else this id starts the series.
  let lineageRootId = publicationId;
  if (publication.previousVersionId) {
    const prev = await getPublicationRow(String(publication.previousVersionId));
    lineageRootId = (prev && prev.lineageRootId) || String(publication.previousVersionId);
  }

  const prefix = pubPrefix(publicationId);
  await s3PutJson(PUBLICATIONS_BUCKET, `${prefix}publication.json`, publication);
  await s3PutJson(PUBLICATIONS_BUCKET, `${prefix}manifest.json`, manifest);
  await s3PutJson(PUBLICATIONS_BUCKET, `${prefix}packages.json`, packages);

  const createdAt = Date.now();
  await ddb.send(new PutCommand({
    TableName: PUBLICATIONS_TABLE,
    Item: {
      PK: `REGISTRY#${REGISTRY_ID}`,
      SK: `PUB#${publicationId}`,
      GSI1PK: `REGISTRY#${REGISTRY_ID}#ROOT#${lineageRootId}`,
      GSI1SK: `CREATED#${String(createdAt).padStart(16, '0')}`,
      publicationId,
      publisherPublicKey: signerKey,
      publisherUserRef: publication.publishedBy || null,
      title: publication.title || '',
      description: publication.description || '',
      tags: Array.isArray(publication.tags) ? publication.tags : [],
      visibility: publication.visibility || 'unlisted',
      version: publication.version || '1.0.0',
      previousVersionId: publication.previousVersionId || null,
      lineageRootId,
      primaryS3Prefix: prefix,
      bundleHash: manifest.bundleHash || publication.bundleHash || '',
      schemaCompatibility: Number(publication.schemaVersions && publication.schemaVersions.schemaCompatibility) || 1,
      createdAt,
    },
  }));

  return json(200, { publicationId, registryPublicationId: publicationId, lineageRootId, registry: REGISTRY_ID });
}

async function handleGetPublication(event, publicationId) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const row = await getPublicationRow(publicationId);
  if (!row) return json(404, { error: 'not_found', publicationId });
  if (row.visibility === 'private') {
    const identity = await getIdentityRecord(auth.claims.sub);
    if (!identity || row.publisherPublicKey !== identity.publicKey) return json(403, { error: 'forbidden' });
  }
  const prefix = row.primaryS3Prefix || pubPrefix(publicationId);
  const [publication, manifest, packages] = await Promise.all([
    s3GetJson(PUBLICATIONS_BUCKET, `${prefix}publication.json`),
    s3GetJson(PUBLICATIONS_BUCKET, `${prefix}manifest.json`),
    s3GetJson(PUBLICATIONS_BUCKET, `${prefix}packages.json`),
  ]);
  if (!publication || !manifest) return json(404, { error: 'package_missing', publicationId });
  return json(200, { publication, manifest, packages });
}

async function handleListPublications(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const q = ((event.queryStringParameters && event.queryStringParameters.query) || '').toLowerCase();
  const res = await ddb.send(new QueryCommand({
    TableName: PUBLICATIONS_TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `REGISTRY#${REGISTRY_ID}` },
  }));
  let rows = (res.Items || []).filter((r) => r.visibility !== 'private');
  if (q) {
    rows = rows.filter((r) => String(r.title || '').toLowerCase().includes(q)
      || String(r.description || '').toLowerCase().includes(q)
      || (Array.isArray(r.tags) && r.tags.some((t) => String(t).toLowerCase().includes(q))));
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const publications = rows.slice(0, 100).map((r) => ({
    publicationId: r.publicationId, title: r.title, description: r.description, tags: r.tags,
    visibility: r.visibility, version: r.version, publisherUserRef: r.publisherUserRef,
    lineageRootId: r.lineageRootId, bundleHash: r.bundleHash, createdAt: r.createdAt,
  }));
  return json(200, { publications, registry: REGISTRY_ID });
}

// GET /publications/{id}/updates — newer versions in the same lineage (DD-12 B). Walks the
// LineageIndex GSI for the publication's lineageRootId and returns rows created after this one.
async function handlePublicationUpdates(event, publicationId) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const row = await getPublicationRow(publicationId);
  if (!row) return json(404, { error: 'not_found', publicationId });
  const lineageRootId = row.lineageRootId || publicationId;
  const res = await ddb.send(new QueryCommand({
    TableName: PUBLICATIONS_TABLE,
    IndexName: 'LineageIndex',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `REGISTRY#${REGISTRY_ID}#ROOT#${lineageRootId}` },
  }));
  const thisCreatedAt = row.createdAt || 0;
  const updates = (res.Items || [])
    .filter((r) => (r.createdAt || 0) > thisCreatedAt && r.visibility !== 'private')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((r) => ({
      publicationId: r.publicationId, title: r.title, description: r.description,
      version: r.version, previousVersionId: r.previousVersionId, lineageRootId: r.lineageRootId,
      publisherUserRef: r.publisherUserRef, bundleHash: r.bundleHash, createdAt: r.createdAt,
    }));
  return json(200, { publicationId, lineageRootId, updates, registry: REGISTRY_ID });
}

// POST /publications/{id}/import — verify signature server-side and return the package as an
// import plan (§7.4). The client also verifies + performs the local UID reconciliation/install.
// `target: 'workspace'` (team import bridge) is P2b and not yet implemented.
async function handleImportPublication(event, publicationId) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const row = await getPublicationRow(publicationId);
  if (!row) return json(404, { error: 'not_found', publicationId });
  if (row.visibility === 'private') {
    const identity = await getIdentityRecord(auth.claims.sub);
    if (!identity || row.publisherPublicKey !== identity.publicKey) return json(403, { error: 'forbidden' });
  }
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: 'invalid_json' }); }
  if (body.target === 'workspace') return json(501, { error: 'workspace_target_not_implemented' });

  const prefix = row.primaryS3Prefix || pubPrefix(publicationId);
  const [publication, manifest, packages] = await Promise.all([
    s3GetJson(PUBLICATIONS_BUCKET, `${prefix}publication.json`),
    s3GetJson(PUBLICATIONS_BUCKET, `${prefix}manifest.json`),
    s3GetJson(PUBLICATIONS_BUCKET, `${prefix}packages.json`),
  ]);
  if (!publication || !manifest) return json(404, { error: 'package_missing', publicationId });

  // Server-side Ed25519 verification over the bundleHash (matches client signMessage encoding).
  let signatureValid = false;
  if (publication.signature && row.publisherPublicKey && manifest.bundleHash) {
    try {
      signatureValid = verifyEd25519(
        row.publisherPublicKey,
        Buffer.from(String(manifest.bundleHash), 'utf8'),
        publication.signature,
      );
    } catch { signatureValid = false; }
    if (!signatureValid) return json(422, { error: 'signature_invalid', publicationId });
  }

  return json(200, { publication, manifest, packages, target: 'personal', signatureValid, verified: true });
}

// ── Shared workspaces (DD-05 C / AWS_INTEGRATION §6.2, §7.2) ─────────────────────────────
// Composite-key model in SHARED_WS_TABLE: a `#META` row per workspace + one `MEMBER#{id}` row per
// member (also indexed by MemberIndex GSI for "my workspaces"). Roles: viewer<editor<admin<owner.
function newWorkspaceId() {
  return `ws_${crypto.randomBytes(9).toString('base64url')}`;
}

async function getWorkspaceMeta(wsId) {
  const res = await ddb.send(new GetCommand({ TableName: SHARED_WS_TABLE, Key: { PK: `WS#${wsId}`, SK: '#META' } }));
  return res.Item || null;
}

async function getWorkspaceMember(wsId, orchardUserId) {
  const res = await ddb.send(new GetCommand({ TableName: SHARED_WS_TABLE, Key: { PK: `WS#${wsId}`, SK: `MEMBER#${orchardUserId}` } }));
  return res.Item || null;
}

async function listWorkspaceMembers(wsId) {
  const res = await ddb.send(new QueryCommand({
    TableName: SHARED_WS_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :m)',
    ExpressionAttributeValues: { ':pk': `WS#${wsId}`, ':m': 'MEMBER#' },
  }));
  return res.Items || [];
}

// Resolve caller → workspace → their role, enforcing a minimum. Returns { error } or
// { orchardUserId, claims, role, meta }. Reused by Slice-2 object routes.
async function requireWorkspaceRole(event, wsId, minRole) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth;
  const meta = await getWorkspaceMeta(wsId);
  if (!meta) return { error: json(404, { error: 'workspace_not_found', wsId }) };
  const member = await getWorkspaceMember(wsId, auth.orchardUserId);
  const role = member?.role;
  if (!role || (ROLE_RANK[role] || 0) < (ROLE_RANK[minRole] || 99)) {
    return { error: json(403, { error: 'insufficient_role', required: minRole, role: role || null }) };
  }
  return { orchardUserId: auth.orchardUserId, claims: auth.claims, role, meta };
}

async function handleCreateWorkspace(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: 'invalid_json' }); }
  const name = String(body.name || '').trim();
  if (!name) return json(400, { error: 'name_required' });
  const wsId = newWorkspaceId();
  const now = Date.now();
  await ddb.send(new PutCommand({
    TableName: SHARED_WS_TABLE,
    Item: { PK: `WS#${wsId}`, SK: '#META', workspaceId: wsId, name, createdBy: auth.orchardUserId, createdAt: now, updatedAt: now },
  }));
  await ddb.send(new PutCommand({   // creator → owner
    TableName: SHARED_WS_TABLE,
    Item: {
      PK: `WS#${wsId}`, SK: `MEMBER#${auth.orchardUserId}`,
      GSI1PK: `MEMBER#${auth.orchardUserId}`, GSI1SK: `WS#${wsId}`,
      orchardUserId: auth.orchardUserId, role: 'owner', joinedAt: now,
    },
  }));
  return json(200, { workspaceId: wsId, name, role: 'owner', createdAt: now });
}

async function handleListWorkspaces(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const res = await ddb.send(new QueryCommand({
    TableName: SHARED_WS_TABLE, IndexName: 'MemberIndex',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `MEMBER#${auth.orchardUserId}` },
  }));
  const workspaces = [];
  for (const m of res.Items || []) {
    const wsId = String(m.GSI1SK || '').replace(/^WS#/, '');
    const meta = await getWorkspaceMeta(wsId);
    if (meta) workspaces.push({ workspaceId: wsId, name: meta.name, role: m.role, createdAt: meta.createdAt });
  }
  workspaces.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json(200, { workspaces });
}

async function handleGetWorkspace(event, wsId) {
  const ctx = await requireWorkspaceRole(event, wsId, 'viewer');
  if (ctx.error) return ctx.error;
  const members = (await listWorkspaceMembers(wsId)).map((m) => ({ orchardUserId: m.orchardUserId, role: m.role, joinedAt: m.joinedAt }));
  return json(200, {
    workspaceId: wsId, name: ctx.meta.name, createdBy: ctx.meta.createdBy,
    createdAt: ctx.meta.createdAt, role: ctx.role, members,
  });
}

async function handlePatchWorkspace(event, wsId) {
  const ctx = await requireWorkspaceRole(event, wsId, 'admin');
  if (ctx.error) return ctx.error;
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: 'invalid_json' }); }
  const name = String(body.name || '').trim();
  if (!name) return json(400, { error: 'name_required' });
  await ddb.send(new UpdateCommand({
    TableName: SHARED_WS_TABLE, Key: { PK: `WS#${wsId}`, SK: '#META' },
    UpdateExpression: 'SET #n = :n, updatedAt = :u',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':n': name, ':u': Date.now() },
  }));
  return json(200, { workspaceId: wsId, name });
}

async function handleAddMember(event, wsId) {
  const ctx = await requireWorkspaceRole(event, wsId, 'admin');
  if (ctx.error) return ctx.error;
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: 'invalid_json' }); }
  const memberId = String(body.orchardUserId || '').trim();
  const role = String(body.role || 'editor');
  if (!memberId) return json(400, { error: 'orchardUserId_required' });
  if (!ROLE_RANK[role] || role === 'owner') return json(400, { error: 'invalid_role' });   // ownership transfer is separate
  const now = Date.now();
  await ddb.send(new PutCommand({
    TableName: SHARED_WS_TABLE,
    Item: {
      PK: `WS#${wsId}`, SK: `MEMBER#${memberId}`,
      GSI1PK: `MEMBER#${memberId}`, GSI1SK: `WS#${wsId}`,
      orchardUserId: memberId, role, joinedAt: now, invitedBy: ctx.orchardUserId,
    },
  }));
  return json(200, { workspaceId: wsId, orchardUserId: memberId, role });
}

async function handleRemoveMember(event, wsId, memberId) {
  const ctx = await requireWorkspaceRole(event, wsId, 'admin');
  if (ctx.error) return ctx.error;
  const target = await getWorkspaceMember(wsId, memberId);
  if (!target) return json(404, { error: 'member_not_found' });
  if (target.role === 'owner') return json(409, { error: 'cannot_remove_owner' });
  await ddb.send(new DeleteCommand({ TableName: SHARED_WS_TABLE, Key: { PK: `WS#${wsId}`, SK: `MEMBER#${memberId}` } }));
  return json(200, { workspaceId: wsId, removed: memberId });
}

// Team object routes (§7.2) — reuse the scope-taking object cores with role gating:
// viewer reads, editor writes primitives, admin+ deletes a Ground.
async function handleWorkspaceListObjects(event, wsId) {
  const ctx = await requireWorkspaceRole(event, wsId, 'viewer');
  if (ctx.error) return ctx.error;
  const since = event.queryStringParameters?.since || '';
  const limit = Math.min(Number(event.queryStringParameters?.limit || '100'), 500);
  return listObjectsInScope(workspaceScope(wsId), since, limit);
}

async function handleWorkspaceGetObject(event, wsId, rawPath) {
  const ctx = await requireWorkspaceRole(event, wsId, 'viewer');
  if (ctx.error) return ctx.error;
  return getObjectInScope(workspaceScope(wsId), rawPath);
}

async function handleWorkspacePutObject(event, wsId, rawPath) {
  const ctx = await requireWorkspaceRole(event, wsId, 'editor');
  if (ctx.error) return ctx.error;
  let envelope;
  try { envelope = event.body ? JSON.parse(event.body) : null; } catch { return json(400, { error: 'invalid_json' }); }
  return putObjectInScope(workspaceScope(wsId), safeDecode(rawPath), envelope, parseIfMatch(event));
}

async function handleWorkspaceDeleteObject(event, wsId, rawPath) {
  const isGround = /\/ground\.json$/.test(safeDecode(rawPath));
  const ctx = await requireWorkspaceRole(event, wsId, isGround ? 'admin' : 'editor');
  if (ctx.error) return ctx.error;
  return deleteObjectInScope(workspaceScope(wsId), rawPath);
}

async function handleWorkspaceBatchWrite(event, wsId) {
  const ctx = await requireWorkspaceRole(event, wsId, 'editor');
  if (ctx.error) return ctx.error;
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: 'invalid_json' }); }
  return batchWriteInScope(workspaceScope(wsId), body.items);
}

// ── Runtime trace archive (DD-15 B) — opt-in, not synced ─────────────────────────────────
// Explicit per-run upload of a (client-scrubbed) execution bundle to users/{id}/runtime-archives/.
// Objects are tagged orchard-runtime-archive=true so the bucket lifecycle expires them after 90d.
const RUNTIME_ARCHIVE_TAG = 'orchard-runtime-archive=true';

function archiveKey(orchardUserId, executionId) {
  return `users/${orchardUserId}/runtime-archives/${executionId}/archive.json`;
}

function safeExecutionId(raw) {
  const id = String(raw || '');
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

async function handleArchiveExecution(event, rawId) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const executionId = safeExecutionId(rawId);
  if (!executionId) return json(400, { error: 'invalid_execution_id' });

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: 'invalid_json' }); }
  const bundle = body.bundle ?? body;   // accept { bundle } or a raw bundle object
  const archivedAt = Date.now();
  const payload = JSON.stringify({ executionId, archivedAt, bundle });

  await s3.send(new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: archiveKey(auth.orchardUserId, executionId),
    Body: payload,
    ContentType: 'application/json',
    Tagging: RUNTIME_ARCHIVE_TAG,
  }));
  return json(200, { ok: true, executionId, archivedAt });
}

async function handleGetExecutionArchive(event, rawId) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const executionId = safeExecutionId(rawId);
  if (!executionId) return json(400, { error: 'invalid_execution_id' });
  const obj = await s3GetJson(WORKSPACE_BUCKET, archiveKey(auth.orchardUserId, executionId));
  if (!obj) return json(404, { error: 'not_found', executionId });
  return json(200, obj);
}

async function handleDeleteExecutionArchive(event, rawId) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const executionId = safeExecutionId(rawId);
  if (!executionId) return json(400, { error: 'invalid_execution_id' });
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: WORKSPACE_BUCKET, Key: archiveKey(auth.orchardUserId, executionId) }));
  } catch (e) {
    if (e.name !== 'NoSuchKey' && e.$metadata?.httpStatusCode !== 404) throw e;
  }
  return json(200, { ok: true, deleted: executionId });
}

// ── Managed LLM proxy (DD-08) ──────────────────────────────────────────────────────────
// The app's Anthropic key lives in Secrets Manager; signed-in clients call this instead of
// holding a key. v1 is auth-only (any bound user) and BUFFERED (non-streaming). Caches the key
// across warm invocations to avoid a Secrets Manager call per request.
async function getAnthropicKey() {
  if (_anthropicKeyCache) return _anthropicKeyCache;
  if (!ANTHROPIC_SECRET_ARN) return null;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: ANTHROPIC_SECRET_ARN }));
  const raw = res.SecretString || '';
  let key = raw;
  try {
    const parsed = JSON.parse(raw);
    key = parsed.ANTHROPIC_API_KEY || parsed.apiKey || parsed.key || '';
  } catch { /* raw string secret */ }
  _anthropicKeyCache = (key && key.startsWith('sk-ant-')) ? key : null;
  return _anthropicKeyCache;
}

async function handleLlmMessages(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid_json' }); }
  if (!body || !Array.isArray(body.messages) || !body.model) {
    return json(400, { error: 'missing_model_or_messages' });
  }
  delete body.stream;   // proxy is buffered

  const key = await getAnthropicKey();
  if (!key) return json(503, { error: 'llm_not_configured' });

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('LLM proxy upstream error', e);
    return json(502, { error: 'llm_upstream_unreachable' });
  }
  // Pass through Anthropic's status + JSON body verbatim (client parses it like a direct call).
  const text = await upstream.text();
  return { statusCode: upstream.status, headers: { 'content-type': 'application/json' }, body: text };
}

// ── Connectors (broker / OAuth·MCP) — CX-5b (DESIGN_connectors.md §5, §5.2) ───────────────
// The broker's server half. The extension sends {server, tool, args, confirmed}; the proxy injects
// the user's vaulted OAuth token at egress and calls the provider's official API. v1 is a per-provider
// REST adapter (NO MCP server process, per §5.2 — a stdio server would need Fargate; Google has clean
// REST). Per-user link records (the tokens) live in OBJECT_TABLE (PK USER#, SK CONNLINK#{provider});
// the link flow populates them. HONEST DEGRADATION: until a provider's OAuth client is configured (env)
// AND the user has linked, invoke returns a structured 'connector-not-linked' — it never fakes a result.
const CONNECTOR_WRITE_TOOLS = {
  'google-calendar': new Set(['create_event', 'update_event', 'delete_event']),
  'google-gmail': new Set(['send_message', 'create_draft']),
  'google-docs': new Set(['create_document', 'render_document']),   // GD-2 — renders are §8.1-auto CLIENT-side (app-owned doc, drive.file); the belt still demands confirmed:true on the wire
};
function connectorIsWrite(server, tool) {
  const s = CONNECTOR_WRITE_TOOLS[server];
  return !!(s && s.has(tool));
}
function connectorProviderOf(server) { return String(server || '').split('-')[0]; }   // google-calendar → google

// The per-user link/token record. Absent (or no refreshToken) = the provider isn't linked for this user.
async function getConnectorLink(orchardUserId, provider) {
  const res = await ddb.send(new GetCommand({
    TableName: OBJECT_TABLE,
    Key: { PK: `USER#${orchardUserId}`, SK: `CONNLINK#${provider}` },
  }));
  return res.Item || null;
}

// POST /connectors/invoke — the execution endpoint the extension's CloudClient.invokeConnector calls.
async function handleConnectorInvoke(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: 'invalid_json' }); }
  const server = String(body.server || '').trim();
  const tool = String(body.tool || '').trim();
  if (!server || !tool) return json(400, { error: 'connector-no-binding' });
  // Belt (§9) — defense in depth: the extension already fail-closed on writes; the proxy re-checks that
  // a write carries an explicit confirmed:true and never runs one unattended.
  if (connectorIsWrite(server, tool) && body.confirmed !== true) {
    return json(403, { error: 'write-needs-confirm', server, tool });
  }
  const provider = connectorProviderOf(server);
  const link = await getConnectorLink(auth.orchardUserId, provider);
  if (!link || !link.refreshToken) {
    return json(409, { error: 'connector-not-linked', provider, hint: `link ${provider} first` });
  }
  // MP-2b — exchange the vaulted refresh token → a short-lived access token, then speak MCP to the curated
  // endpoint (mcp.cjs; the server→URL map is SERVER-SIDE only — anti-SSRF). Tool/transport failures return
  // 200 + { success:false, … } — the §5 envelope the extension's brokerReplyFromCloud already consumes;
  // config/link problems stay HTTP-status-shaped (503/409) like the rest of this section.
  const tok = await refreshAccessToken(provider, link.refreshToken);   // MP-3b — oauth.cjs owns the token endpoints + creds
  if (tok.error === 'connector-not-configured') return json(503, { error: 'connector-not-configured', provider, hint: 'no OAuth client registered for this provider' });
  if (tok.error) return json(200, { success: false, error: 'broker-unauthorized', hint: `token refresh failed — re-link ${provider}` });
  // v1318 — per-server CHANNEL: Google's MCP servers are Developer-Preview-gated (a consumer @gmail.com can't
  // enroll — the live PERMISSION_DENIED, findings 2026-07-01), so Google serves via GA REST; everything else speaks
  // MCP. Flip a server to 'mcp' when its provider ships GA — the extension never knows which channel served it.
  const channel = CONNECTOR_CHANNEL[server] || 'mcp';
  const invokeArgs = { server, tool, args: (body.args && typeof body.args === 'object') ? body.args : {}, accessToken: tok.accessToken };
  const result = channel === 'google-rest' ? await invokeGoogleRestTool(invokeArgs) : await invokeMcpTool(invokeArgs);
  if (!result.success) console.error('connector-invoke failed', server, tool, `[${channel}]`, result.error, result.hint || '');   // v1314 — CloudWatch names the tool's own error (no secrets)
  return json(200, result);
}
const CONNECTOR_CHANNEL = { 'google-calendar': 'google-rest', 'google-docs': 'google-rest' };   // v1318/GD-2 — per-server execution channel (default 'mcp')

// GET /connectors/tools — MP-2c discovery: which providers the CALLER has linked + the LIVE tool descriptors
// (tools/list) for each linked provider's MCP-channel servers. Descriptors only, never tokens. REST-channel servers
// (Google today — its MCP is preview-gated) are SKIPPED: their tools are seed-defined client-side, and calling the
// ineligible MCP endpoint would just re-manufacture the PERMISSION_DENIED. Per-server failures ride back named
// ({server, error, hint}) — one bad server never hides another's tools.
async function handleConnectorTools(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const linked = [];
  const servers = [];
  for (const provider of Object.keys(CONNECTOR_TOKEN_URLS)) {
    const link = await getConnectorLink(auth.orchardUserId, provider);
    if (!link || !link.refreshToken) continue;
    linked.push(provider);
    const mcpServers = Object.keys(MCP_ENDPOINTS).filter((s) => connectorProviderOf(s) === provider && (CONNECTOR_CHANNEL[s] || 'mcp') === 'mcp');
    if (!mcpServers.length) continue;
    const tok = await refreshAccessToken(provider, link.refreshToken);
    if (tok.error) { for (const s of mcpServers) servers.push({ server: s, error: tok.error }); continue; }
    for (const s of mcpServers) {
      const r = await listMcpTools({ server: s, accessToken: tok.accessToken });
      servers.push(r.success ? { server: s, tools: r.tools } : { server: s, error: r.error, hint: r.hint });
    }
  }
  return json(200, { linked, servers });
}

// POST /connectors/link/{provider} — complete the link (MP-3, §5.2 pinned contract): the extension danced the
// PKCE authorize CLIENT-side (launchWebAuthFlow) and posts {code, redirectUri, codeVerifier} on the JWT-authed
// channel; we exchange server-side (the client secret never leaves this Lambda) and VAULT the refresh token at
// CONNLINK#{provider}. No unauthenticated callback route exists — the redirect never touches this API.
async function handleConnectorLink(event, provider) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: 'invalid_json' }); }
  const code = String(body.code || '').trim();
  const redirectUri = String(body.redirectUri || '').trim();
  if (!code || !redirectUri) return json(400, { error: 'link-missing-fields' });
  const ex = await exchangeAuthCode(provider, { code, redirectUri, codeVerifier: body.codeVerifier }, {});
  if (ex.error === 'connector-not-configured') return json(503, { error: 'connector-not-configured', provider, hint: 'no OAuth client registered for this provider' });
  if (ex.error) {
    console.error('connector-link failed', provider, ex.error, ex.hint || '');   // v1313 — CloudWatch gets the provider's rejection code (no secrets)
    return json(502, { error: ex.error, provider, hint: ex.hint });
  }
  await ddb.send(new PutCommand({
    TableName: OBJECT_TABLE,
    Item: { PK: `USER#${auth.orchardUserId}`, SK: `CONNLINK#${provider}`, provider, refreshToken: ex.refreshToken, scope: ex.scope, linkedAt: new Date().toISOString() },
  }));
  return json(200, { success: true, provider, scope: ex.scope });
}

// DELETE /connectors/link/{provider} — unlink: best-effort revoke at the provider, then drop the vault record.
async function handleConnectorUnlink(event, provider) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;
  const link = await getConnectorLink(auth.orchardUserId, provider);
  if (link && link.refreshToken && provider === 'google') {
    // Best-effort: a failed revoke must not block the unlink (the vault record is the thing we own).
    try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: link.refreshToken }).toString() }); } catch { /* best-effort */ }
  }
  await ddb.send(new DeleteCommand({ TableName: OBJECT_TABLE, Key: { PK: `USER#${auth.orchardUserId}`, SK: `CONNLINK#${provider}` } }));
  return json(200, { success: true, provider, unlinked: true });
}

exports.handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method || 'GET';
    const path = routePath(event);

    // Reject oversized bodies up front (before any JSON.parse) — cost/DoS guard.
    if (event.body && Buffer.byteLength(event.body, event.isBase64Encoded ? 'base64' : 'utf8') > MAX_REQUEST_BODY_BYTES) {
      return json(413, { error: 'payload_too_large', limitBytes: MAX_REQUEST_BODY_BYTES });
    }

    if (method === 'GET' && path === '/identity/me') return handleIdentityMe(event);
    if (method === 'POST' && path === '/identity/bind/challenge') return handleBindChallenge(event);
    if (method === 'POST' && path === '/identity/bind') return handleBind(event);

    if (method === 'GET' && path === '/objects') return handleListObjects(event);
    if (method === 'POST' && path === '/objects/presign-put') return handlePresignPut(event);
    if (method === 'POST' && path === '/objects/complete-put') return handleCompletePut(event);
    if (method === 'POST' && path === '/objects/batch') return handleBatchWrite(event);
    if (method === 'GET' && path.startsWith('/objects/')) return handleGetObject(event);
    if (method === 'PUT' && path.startsWith('/objects/')) return handlePutObject(event);
    if (method === 'DELETE' && path.startsWith('/objects/')) return handleDeleteObject(event);

    if (method === 'POST' && path === '/publications') return handlePublishPublication(event);
    if (method === 'GET' && path === '/publications') return handleListPublications(event);
    if (path.startsWith('/publications/')) {
      const rest = path.slice('/publications/'.length);
      const updatesMatch = rest.match(/^(.+)\/updates$/);
      const importMatch = rest.match(/^(.+)\/import$/);
      if (method === 'GET' && updatesMatch) {
        return handlePublicationUpdates(event, decodeURIComponent(updatesMatch[1]));
      }
      if (method === 'POST' && importMatch) {
        return handleImportPublication(event, decodeURIComponent(importMatch[1]));
      }
      if (method === 'GET') return handleGetPublication(event, decodeURIComponent(rest));
    }

    // Shared workspaces (DD-05 C). Object routes under /workspaces/{wsId}/objects land in Slice 2.
    if (method === 'POST' && path === '/workspaces') return handleCreateWorkspace(event);
    if (method === 'GET' && path === '/workspaces') return handleListWorkspaces(event);
    if (path.startsWith('/workspaces/')) {
      const rest = path.slice('/workspaces/'.length);
      // Object routes first — batch / list / by-path. {wsId}/objects/batch matches before the
      // generic {wsId}/objects/(.+) so "batch" isn't treated as a logical path.
      const objBatchMatch = rest.match(/^([^/]+)\/objects\/batch$/);
      const objListMatch = rest.match(/^([^/]+)\/objects$/);
      const objPathMatch = rest.match(/^([^/]+)\/objects\/(.+)$/);
      if (method === 'POST' && objBatchMatch) return handleWorkspaceBatchWrite(event, decodeURIComponent(objBatchMatch[1]));
      if (method === 'GET' && objListMatch) return handleWorkspaceListObjects(event, decodeURIComponent(objListMatch[1]));
      if (objPathMatch && !objBatchMatch) {
        const wsId = decodeURIComponent(objPathMatch[1]);
        const rawObjPath = objPathMatch[2];   // raw — resolveObjectPath / safeDecode handle encoding
        if (method === 'GET') return handleWorkspaceGetObject(event, wsId, rawObjPath);
        if (method === 'PUT') return handleWorkspacePutObject(event, wsId, rawObjPath);
        if (method === 'DELETE') return handleWorkspaceDeleteObject(event, wsId, rawObjPath);
      }

      const memberMatch = rest.match(/^([^/]+)\/members\/([^/]+)$/);
      const membersMatch = rest.match(/^([^/]+)\/members$/);
      if (method === 'DELETE' && memberMatch) {
        return handleRemoveMember(event, decodeURIComponent(memberMatch[1]), decodeURIComponent(memberMatch[2]));
      }
      if (method === 'POST' && membersMatch) {
        return handleAddMember(event, decodeURIComponent(membersMatch[1]));
      }
      const idOnly = rest.match(/^([^/]+)$/);
      if (idOnly) {
        const wsId = decodeURIComponent(idOnly[1]);
        if (method === 'GET') return handleGetWorkspace(event, wsId);
        if (method === 'PATCH') return handlePatchWorkspace(event, wsId);
      }
    }

    // Runtime trace archive (DD-15 B): /runtime/executions/{id}/archive
    if (path.startsWith('/runtime/executions/')) {
      const m = path.match(/^\/runtime\/executions\/([^/]+)\/archive$/);
      if (m) {
        const execId = decodeURIComponent(m[1]);
        if (method === 'POST') return handleArchiveExecution(event, execId);
        if (method === 'GET') return handleGetExecutionArchive(event, execId);
        if (method === 'DELETE') return handleDeleteExecutionArchive(event, execId);
      }
    }

    if (method === 'POST' && path === '/llm/messages') return handleLlmMessages(event);

    // Connectors (broker / OAuth·MCP) — CX-5b §5
    if (method === 'POST' && path === '/connectors/invoke') return handleConnectorInvoke(event);
    if (method === 'GET' && path === '/connectors/tools') return handleConnectorTools(event);
    if (path.startsWith('/connectors/link/')) {
      const provider = decodeURIComponent(path.slice('/connectors/link/'.length));
      if (method === 'POST' && provider) return handleConnectorLink(event, provider);
      if (method === 'DELETE' && provider) return handleConnectorUnlink(event, provider);
    }

    return json(404, { error: 'not_found', method, path });
  } catch (err) {
    console.error(err);   // full detail to CloudWatch only
    // Don't leak internal exception text (bucket names, key fragments, SDK internals) to clients.
    return json(500, { error: 'internal_error', requestId: event.requestContext?.requestId });
  }
};

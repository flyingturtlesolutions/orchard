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
} = require('@aws-sdk/lib-dynamodb');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const IDENTITY_TABLE = process.env.IDENTITY_TABLE;
const OBJECT_TABLE = process.env.OBJECT_TABLE;
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET;
const MAX_BATCH = 10;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

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

function objectKeys(orchardUserId, logicalPath) {
  return {
    PK: `USER#${orchardUserId}`,
    SK: `PATH#${logicalPath}`,
  };
}

async function getIndexRecord(orchardUserId, logicalPath) {
  const res = await ddb.send(new GetCommand({
    TableName: OBJECT_TABLE,
    Key: objectKeys(orchardUserId, logicalPath),
  }));
  return res.Item || null;
}

function s3Key(orchardUserId, logicalPath) {
  return `users/${orchardUserId}/${logicalPath}`;
}

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

async function handleGetObject(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  const path = routePath(event);
  const logicalPath = decodeURIComponent(path.replace(/^\/objects\/?/, ''));
  if (!logicalPath || isPathDenied(logicalPath)) {
    return json(logicalPath ? 403 : 400, { error: logicalPath ? 'path_denied' : 'invalid_path' });
  }

  const index = await getIndexRecord(auth.orchardUserId, logicalPath);
  if (index?.deleted) {
    return json(404, { error: 'not_found', path: logicalPath });
  }

  const key = s3Key(auth.orchardUserId, logicalPath);

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

async function handleListObjects(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  const since = event.queryStringParameters?.since || '';
  const limit = Math.min(Number(event.queryStringParameters?.limit || '100'), 500);

  const params = {
    TableName: OBJECT_TABLE,
    IndexName: 'ChangeFeed',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `USER#${auth.orchardUserId}`,
    },
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

async function writeOneObject(orchardUserId, item) {
  const { path: logicalPath, envelope } = item;
  const expectedEtag = item.expectedEtag ?? '*';

  if (!logicalPath || !envelope || isPathDenied(logicalPath)) {
    return { error: json(400, { error: 'invalid_item', path: logicalPath }) };
  }

  const existing = await getIndexRecord(orchardUserId, logicalPath);
  const serverEtag = existing?.etag || null;

  if (expectedEtag !== '*' && serverEtag && normalizeEtag(expectedEtag) !== normalizeEtag(serverEtag)) {
    let serverBody = null;
    try {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: WORKSPACE_BUCKET,
        Key: s3Key(orchardUserId, logicalPath),
      }));
      serverBody = JSON.parse(await obj.Body.transformToString());
    } catch {
      serverBody = null;
    }
    const meta = conflictResolution(logicalPath, envelope, serverBody);
    return {
      conflict: json(409, {
        error: 'conflict',
        path: logicalPath,
        server: serverBody,
        client: envelope,
        ...meta,
      }),
    };
  }

  const bodyStr = JSON.stringify(envelope);
  const updatedAt = envelope.updatedAt || Date.now();
  const putRes = await s3.send(new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: s3Key(orchardUserId, logicalPath),
    Body: bodyStr,
    ContentType: 'application/json',
  }));

  const etag = normalizeEtag(putRes.ETag || crypto.createHash('md5').update(bodyStr).digest('hex'));
  const indexItem = {
    ...objectKeys(orchardUserId, logicalPath),
    GSI2PK: `USER#${orchardUserId}`,
    GSI2SK: gsi2Sk(updatedAt, logicalPath),
    path: logicalPath,
    groundId: extractGroundId(logicalPath),
    primitiveType: extractPrimitiveType(logicalPath),
    schemaVersion: envelope.schemaVersion || 1,
    updatedAt,
    etag,
    sizeBytes: Buffer.byteLength(bodyStr),
    lifecycle: envelope.lifecycle || 'active',
    s3VersionId: putRes.VersionId || null,
  };

  await ddb.send(new PutCommand({
    TableName: OBJECT_TABLE,
    Item: indexItem,
  }));

  return { path: logicalPath, etag, updatedAt };
}

async function handlePutObject(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  const path = routePath(event);
  const logicalPath = decodeURIComponent(path.replace(/^\/objects\/?/, ''));
  if (!logicalPath || isPathDenied(logicalPath)) {
    return json(logicalPath ? 403 : 400, { error: logicalPath ? 'path_denied' : 'invalid_path' });
  }

  let envelope;
  try {
    envelope = event.body ? JSON.parse(event.body) : null;
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (!envelope) return json(400, { error: 'envelope required' });

  const expectedEtag = parseIfMatch(event);
  const result = await writeOneObject(auth.orchardUserId, {
    path: logicalPath,
    envelope,
    expectedEtag,
  });

  if (result.conflict) return result.conflict;
  if (result.error) return result.error;

  return json(200, { path: result.path, etag: result.etag, updatedAt: result.updatedAt });
}

async function handleDeleteObject(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  const path = routePath(event);
  const logicalPath = decodeURIComponent(path.replace(/^\/objects\/?/, ''));
  if (!logicalPath || isPathDenied(logicalPath)) {
    return json(logicalPath ? 403 : 400, { error: logicalPath ? 'path_denied' : 'invalid_path' });
  }

  const existing = await getIndexRecord(auth.orchardUserId, logicalPath);
  const updatedAt = Math.max(Date.now(), (existing?.updatedAt || 0) + 1);

  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: s3Key(auth.orchardUserId, logicalPath),
    }));
  } catch (e) {
    if (e.name !== 'NoSuchKey' && e.$metadata?.httpStatusCode !== 404) throw e;
  }

  await ddb.send(new PutCommand({
    TableName: OBJECT_TABLE,
    Item: {
      ...objectKeys(auth.orchardUserId, logicalPath),
      GSI2PK: `USER#${auth.orchardUserId}`,
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

async function handleBatchWrite(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const items = body.items;
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
    const existing = await getIndexRecord(auth.orchardUserId, item.path);
    const serverEtag = existing?.etag || null;
    if (expectedEtag !== '*' && serverEtag && normalizeEtag(expectedEtag) !== normalizeEtag(serverEtag)) {
      let serverBody = null;
      try {
        const obj = await s3.send(new GetObjectCommand({
          Bucket: WORKSPACE_BUCKET,
          Key: s3Key(auth.orchardUserId, item.path),
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
        client: item.envelope,
        ...meta,
      });
    }
  }

  const written = [];
  const s3KeysWritten = [];

  try {
    for (const item of items) {
      const result = await writeOneObject(auth.orchardUserId, item);
      if (result.conflict) {
        throw Object.assign(new Error('conflict'), { response: result.conflict });
      }
      if (result.error) {
        throw Object.assign(new Error('write_failed'), { response: result.error });
      }
      written.push(result);
      s3KeysWritten.push(s3Key(auth.orchardUserId, item.path));
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

exports.handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method || 'GET';
    const path = routePath(event);

    if (method === 'GET' && path === '/identity/me') return handleIdentityMe(event);
    if (method === 'POST' && path === '/identity/bind/challenge') return handleBindChallenge(event);
    if (method === 'POST' && path === '/identity/bind') return handleBind(event);

    if (method === 'GET' && path === '/objects') return handleListObjects(event);
    if (method === 'POST' && path === '/objects/batch') return handleBatchWrite(event);
    if (method === 'GET' && path.startsWith('/objects/')) return handleGetObject(event);
    if (method === 'PUT' && path.startsWith('/objects/')) return handlePutObject(event);
    if (method === 'DELETE' && path.startsWith('/objects/')) return handleDeleteObject(event);

    return json(404, { error: 'not_found', method, path });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'internal_error', message: err.message });
  }
};

// Core/brokerInvoke.js — CX-5b (v2.74.1306). The PURE half of a broker (OAuth/MCP) tool invocation: the fail-closed
// write gate + the cloud-response normalizer. The impure half (the actual POST /connectors/invoke to the proxy) lives
// in the INVOKE_CONNECTOR handler — this is the part that's testable without a network. DESIGN_connectors.md §5, §7, §9.
//
// The broker mirrors the session-ride belts (§9): a WRITE (leg mode 'act' → payload.write) is FAIL-CLOSED behind an
// explicit post-HITL `confirmed:true`, checked HERE at the execution boundary — so a write can never fire unattended
// or unconfirmed. The backend proxy re-checks (defense in depth), but this belt stops a write before it ever leaves
// the extension. Reads (`write:false`) pass straight through.
//
// @module Core/brokerInvoke

/**
 * Validate + gate a broker invoke payload (the execPlan INVOKE_CONNECTOR payload). PURE.
 * @param {{ server?:string, tool?:string, args?:object, write?:boolean, confirmed?:boolean }} [payload]
 * @returns {{ ok:true, write:boolean, request:{server:string, tool:string, args:object, confirmed:boolean} }
 *          | { ok:false, error:string, hint?:string }}
 */
export function brokerInvokeGate(payload = {}) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const server = typeof p.server === 'string' ? p.server.trim() : '';
  const tool = typeof p.tool === 'string' ? p.tool.trim() : '';
  if (!server || !tool) return { ok: false, error: 'connector-no-binding' };
  const write = p.write === true;
  const confirmed = p.confirmed === true;
  // Belt #1 (§9): a write can NEVER run without explicit post-HITL confirmation. Fail-closed at the boundary.
  if (write && !confirmed) return { ok: false, error: 'write-needs-confirm', hint: 'confirm the action first' };
  const args = (p.args && typeof p.args === 'object') ? p.args : {};
  return { ok: true, write, request: { server, tool, args, confirmed } };
}

/**
 * Normalize the cloud proxy's reply (or a thrown CloudClientError) into the uniform handler reply shape that
 * `toObservation` consumes ({ success, value | error }). PURE — no network. A 404/501 (endpoint/proxy not
 * provisioned) degrades to a clear 'broker-unavailable' rather than a raw failure, so an un-deployed broker fails
 * HONESTLY instead of looking broken. The proxy contract (§5) is `{ success, value | error }`.
 * @param {{ resp?:any, err?:{ status?:number, message?:string }|null }} [io]
 * @returns {{ success:true, value:any } | { success:false, error:string, hint?:string }}
 */
export function brokerReplyFromCloud({ resp = null, err = null } = {}) {
  if (err) {
    const body = (err && err.body && typeof err.body === 'object') ? err.body : null;
    // v1342 (review H) — the thrown-path must read err.body (403 write-needs-confirm, 409 hints, 503 config).
    if (body && body.error) {
      const out = { success: false, error: String(body.error) };
      if (body.hint) out.hint = String(body.hint);
      return out;
    }
    const status = (err && typeof err.status === 'number') ? err.status : 0;
    if (status === 404 || status === 501) return { success: false, error: 'broker-unavailable', hint: 'the connector proxy is not provisioned yet' };
    if (status === 401 || status === 403) return { success: false, error: 'broker-unauthorized', hint: 'link this connector (sign in) first' };
    return { success: false, error: (err && err.message) || 'broker-failed' };
  }
  if (resp && typeof resp === 'object') {
    // v2.74.1314 — carry the proxy's HINT through (the tool's own error text, e.g. Google's PERMISSION_DENIED
    // detail). The 2026-07-01 link failure taught this lesson on the LINK path; the first live READ hit the same
    // drop HERE — a `tool-error` with its self-naming reason stripped. The hint must survive every hop.
    if (resp.success === false || resp.error) {
      const out = { success: false, error: String(resp.error || 'broker-failed') };
      if (resp.hint) out.hint = String(resp.hint);
      return out;
    }
    return { success: true, value: ('value' in resp) ? resp.value : resp };
  }
  return { success: true, value: resp };
}

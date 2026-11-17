import { auditDb } from './db.ts';
import { canonicalHash, newId } from './crypto.ts';

export interface AuditEntryInput {
  societyId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  at?: string;
}

export function appendAuditEvent(input: AuditEntryInput): { id: string; hash: string } {
  const id = newId('aud');
  const at = input.at || new Date().toISOString();
  const beforeJson = input.before !== undefined ? JSON.stringify(input.before) : null;
  const afterJson = input.after !== undefined ? JSON.stringify(input.after) : null;
  const reason = input.reason ?? null;

  const lastRow = auditDb
    .prepare('SELECT hash FROM audit_event_log WHERE society_id = ? ORDER BY seq DESC LIMIT 1')
    .get(input.societyId) as { hash: string } | undefined;

  const prevHash = lastRow?.hash ?? '0000000000000000000000000000000000000000000000000000000000000000';
  const hash = canonicalHash({
    prevHash,
    id,
    societyId: input.societyId,
    at,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeJson,
    afterJson,
    reason,
  });

  auditDb
    .prepare(
      `INSERT INTO audit_event_log (
        id, society_id, at, actor_id, action, entity_type, entity_id,
        before_json, after_json, reason, prev_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.societyId,
      at,
      input.actorId,
      input.action,
      input.entityType,
      input.entityId,
      beforeJson,
      afterJson,
      reason,
      prevHash,
      hash
    );

  return { id, hash };
}

export function verifyAuditChain(societyId: string): {
  valid: boolean;
  totalEvents: number;
  headHash: string | null;
  brokenAtSeq: number | null;
} {
  const rows = auditDb
    .prepare(
      `SELECT seq, id, society_id, at, actor_id, action, entity_type, entity_id,
              before_json, after_json, reason, prev_hash, hash
       FROM audit_event_log WHERE society_id = ? ORDER BY seq ASC`
    )
    .all(societyId) as Array<{
    seq: number;
    id: string;
    society_id: string;
    at: string;
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before_json: string | null;
    after_json: string | null;
    reason: string | null;
    prev_hash: string;
    hash: string;
  }>;

  let expectedPrev = '0000000000000000000000000000000000000000000000000000000000000000';
  let headHash: string | null = null;

  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { valid: false, totalEvents: rows.length, headHash, brokenAtSeq: row.seq };
    }
    const recomputed = canonicalHash({
      prevHash: row.prev_hash,
      id: row.id,
      societyId: row.society_id,
      at: row.at,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      beforeJson: row.before_json,
      afterJson: row.after_json,
      reason: row.reason,
    });
    if (recomputed !== row.hash) {
      return { valid: false, totalEvents: rows.length, headHash, brokenAtSeq: row.seq };
    }
    expectedPrev = row.hash;
    headHash = row.hash;
  }

  return { valid: true, totalEvents: rows.length, headHash, brokenAtSeq: null };
}

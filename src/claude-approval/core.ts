import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(256);
export const hookSchema = z.object({ session_id: id, hook_event_name: z.enum(['PreToolUse','PermissionRequest']), tool_use_id: id.optional(), tool_name: id, tool_input: z.record(z.string(), z.unknown()), permission_mode: z.string().optional() });
export type Hook = z.infer<typeof hookSchema>;
const answerSchema = z.object({ action: z.enum(['allow','deny','answers','bypass']), feedback: z.string().max(4000).optional(), answers: z.record(z.string(), z.union([z.string().min(1).max(4000), z.array(z.string().min(1).max(1000)).min(1).max(20)])).optional() }).strict();
export type Answer = z.infer<typeof answerSchema>;
export type Request = { id: string; session: string; hook: Hook; expires: number; state: string; bypass: boolean };
export function denial(h: Pick<Hook,'hook_event_name'>, reason: string) {
  return { hookSpecificOutput: h.hook_event_name === 'PermissionRequest'
    ? { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } }
    : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}
export function output(h: Hook, a: Answer) {
  if (a.action === 'deny') return denial(h, a.feedback || 'REMOTE_DENIED');
  if (h.tool_name === 'AskUserQuestion') return { hookSpecificOutput: { hookEventName: h.hook_event_name, permissionDecision: 'allow', updatedInput: { ...h.tool_input, answers: a.answers } } };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', ...(h.tool_name === 'ExitPlanMode' ? { updatedInput: h.tool_input } : {}), ...(a.action === 'bypass' ? { updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] } : {}) } } };
}
export class ApprovalStore {
  readonly db: DatabaseSync;
  constructor(path: string, private now = Date.now, private audit: (event: string, request?: string) => void = () => {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,bypass INTEGER,active INTEGER,lease INTEGER);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,session TEXT,hook TEXT,expires INTEGER,state TEXT,answer TEXT,available INTEGER, fingerprint TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY);
      UPDATE sessions SET active=0;
      UPDATE requests SET state='cancelled',hook='{}',answer=NULL WHERE state NOT IN ('consumed','cancelled');`);
  }
  register(session: string, bypass: boolean) {
    id.parse(session); z.boolean().parse(bypass);
    // A terminated/restarted session cannot be resurrected with its old ID.
    this.db.prepare('INSERT INTO sessions VALUES(?,?,1,?)').run(session, Number(bypass), this.now()+15000);
  }
  active(session: string) { return !!this.db.prepare('SELECT id FROM sessions WHERE id=? AND active=1 AND lease>?').get(session,this.now()); }
  heartbeat(session: string) { if (!this.active(session)) throw new Error('inactive_session'); this.db.prepare('UPDATE sessions SET lease=? WHERE id=?').run(this.now()+15000,session); }
  sweep() {
    this.db.prepare('UPDATE sessions SET active=0 WHERE lease<=?').run(this.now());
    this.db.prepare("UPDATE requests SET state='cancelled',hook='{}',answer=NULL WHERE state NOT IN ('consumed','cancelled') AND (expires<=? OR session IN (SELECT id FROM sessions WHERE active=0))").run(this.now());
  }
  cancel(session?: string) {
    this.db.prepare(`UPDATE sessions SET active=0${session ? ' WHERE id=?' : ''}`).run(...(session ? [session] : []));
    this.db.prepare(`UPDATE requests SET state='cancelled',hook='{}',answer=NULL WHERE state!='consumed'${session ? ' AND session=?' : ''}`).run(...(session ? [session] : []));
  }
  create(raw: unknown, ttl: number): Request {
    const h = hookSchema.parse(raw);
    if (!this.active(h.session_id)) throw new Error('inactive_session');
    if (h.hook_event_name === 'PreToolUse' && h.tool_name !== 'AskUserQuestion') throw new Error('unsupported_request');
    if (!Number.isFinite(ttl) || ttl < 100 || ttl > 240000) throw new Error('invalid_ttl');
    const serialized = JSON.stringify(h);
    if (Buffer.byteLength(serialized) > 48000) throw new Error('request_too_large');
    if (h.tool_name === 'AskUserQuestion') questions(h);
    const fingerprint = createHash('sha256').update(h.session_id + ':' + (h.tool_use_id || serialized) + ':' + h.hook_event_name).digest('hex');
    const session = this.db.prepare('SELECT bypass FROM sessions WHERE id=?').get(h.session_id)!;
    const r = { id: randomUUID(), session: h.session_id, hook: h, expires: this.now() + ttl, state: 'pending', bypass: session.bypass === 1 };
    this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,NULL,0,?)').run(r.id,r.session,serialized,r.expires,r.state,fingerprint);
    this.audit('created',r.id); return r;
  }
  delivered(rid: string) { this.db.prepare("UPDATE requests SET available=1 WHERE id=? AND state='pending'").run(rid); }
  fail(rid: string) { this.db.prepare("UPDATE requests SET state='cancelled',hook='{}',answer=NULL WHERE id=? AND state!='consumed'").run(rid); this.audit('delivery_failed',rid); }
  answer(rid: string, session: string, event: string, raw: unknown): string {
    const a = answerSchema.parse(raw); id.parse(event);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db.prepare('SELECT * FROM requests WHERE id=?').get(rid);
      if (!r || r.session !== session || !this.active(session)) return 'invalid_request';
      if (Number(r.expires) <= this.now()) return 'expired';
      if (r.available !== 1) return 'not_delivered';
      if (this.db.prepare('SELECT id FROM events WHERE id=?').get(event)) return 'duplicate_event';
      // Denial may replace a queued allow until the hook atomically consumes it.
      if (r.state !== 'pending' && !(r.state === 'answered' && a.action === 'deny')) return 'already_decided';
      const h = JSON.parse(String(r.hook)) as Hook;
      const s = this.db.prepare('SELECT bypass FROM sessions WHERE id=?').get(session)!;
      if (a.action === 'bypass' && !(h.tool_name === 'ExitPlanMode' && h.hook_event_name === 'PermissionRequest' && h.permission_mode === 'plan' && s.bypass === 1)) return 'bypass_unavailable';
      if (a.action !== 'deny' && h.tool_name === 'AskUserQuestion') {
        if (a.action !== 'answers' || !a.answers) return 'answers_required';
        const qs = questions(h);
        if (Object.keys(a.answers).length !== qs.length) return 'incomplete_answers';
        for (const q of qs) {
          const value = a.answers[q.question];
          if (!value || (Array.isArray(value) && (!q.multiSelect || new Set(value).size !== value.length || value.some(v => !q.options.some(o => o.label === v))))) return 'invalid_answers';
          if (Array.isArray(value)) a.answers[q.question] = value.join(', ');
        }
      } else if (a.action === 'answers') return 'unexpected_answers';
      this.db.prepare('INSERT INTO events VALUES(?)').run(event);
      this.db.prepare("UPDATE requests SET state='answered',answer=? WHERE id=?").run(JSON.stringify(a),rid);
      this.audit(a.action === 'deny' ? 'denied' : 'answered',rid); return 'accepted';
    } finally { this.db.exec('COMMIT'); }
  }
  consume(rid: string, session: string): { done: boolean; result?: unknown } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db.prepare('SELECT * FROM requests WHERE id=? AND session=?').get(rid,session);
      if (!r || !this.active(session) || ['cancelled','consumed'].includes(String(r.state))) throw new Error('invalid_request');
      const h = JSON.parse(String(r.hook)) as Hook;
      if (Number(r.expires) <= this.now()) {
        this.fail(rid); return { done: true, result: denial(h,'REMOTE_TIMEOUT') };
      }
      if (r.state !== 'answered') return { done: false };
      const result = output(h,JSON.parse(String(r.answer)));
      this.db.prepare("UPDATE requests SET state='consumed',hook='{}',answer=NULL WHERE id=?").run(rid);
      this.audit('consumed',rid); return { done: true, result };
    } finally { this.db.exec('COMMIT'); }
  }
  close() { this.cancel(); this.db.close(); }
}
const questionSchema = z.array(z.object({ question: z.string().min(1).max(4000), multiSelect: z.boolean().optional(), options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).min(1).max(20) })).min(1).max(10);
function questions(h: Hook) { const q = questionSchema.parse(h.tool_input.questions); if (new Set(q.map(x=>x.question)).size !== q.length) throw new Error('duplicate_questions'); return q; }

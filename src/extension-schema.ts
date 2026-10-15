/** Additive schemas. Independent local intake never manufactures Feishu inbox rows. */
export const localSchema = `
CREATE TABLE local_subscriptions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, bindingId TEXT NOT NULL REFERENCES bindings(id), url TEXT NOT NULL, secret TEXT NOT NULL, expiresAt INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE UNIQUE INDEX local_subscription_binding ON local_subscriptions(bindingId) WHERE active=1;
CREATE TABLE local_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, bindingId TEXT NOT NULL REFERENCES bindings(id), requestId TEXT NOT NULL, subscriptionId TEXT NOT NULL REFERENCES local_subscriptions(id), text TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, UNIQUE(owner,bindingId,requestId));
CREATE INDEX local_events_pending ON local_events(state,nextAt,seq);
CREATE TABLE local_replies (eventId TEXT PRIMARY KEY REFERENCES local_events(id), text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', accessUntil INTEGER NOT NULL, remoteMessageId TEXT);
`;
export const reactionSchema = `
CREATE TABLE callback_reactions (eventId TEXT PRIMARY KEY REFERENCES inbox(id), state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, acceptedAt INTEGER NOT NULL, reactionId TEXT);
`;
export const invalidExtensionQueries = [
  `FROM local_subscriptions s JOIN bindings b ON b.id=s.bindingId WHERE s.owner!=b.owner OR s.active NOT IN (0,1) OR s.expiresAt<0`,
  `FROM local_events e JOIN bindings b ON b.id=e.bindingId JOIN local_subscriptions s ON s.id=e.subscriptionId WHERE e.owner!=b.owner OR s.owner!=e.owner OR s.bindingId!=e.bindingId OR e.state NOT IN ('pending','sending','sent','dead','cancelled','blocked') OR e.attempts<0 OR e.attempts>8 OR e.expiresAt<e.createdAt`,
  `FROM local_replies WHERE state NOT IN ('pending','sending','sent','dead','cancelled','uncertain','blocked') OR accessUntil<0`,
];
export const invalidReactionQueries = [`FROM callback_reactions r JOIN event_handling h ON h.eventId=r.eventId WHERE h.callbackAcceptedAt IS NULL OR r.state NOT IN ('pending','sending','sent','dead','cancelled','uncertain') OR r.attempts<0 OR r.attempts>8 OR r.acceptedAt<0`];

// Fail closed before crash recovery on SQLite's permissive type affinities.
for (const [table,columns] of [
  ['local_subscriptions',['expiresAt','active']],
  ['local_events',['seq','createdAt','expiresAt','attempts','nextAt']],
  ['local_replies',['accessUntil']],
] as const) for(const column of columns) invalidExtensionQueries.push(`FROM ${table} WHERE typeof(${column})!='integer' OR ${column}<0 OR ${column}>9007199254740991`);
for(const column of ['attempts','nextAt','acceptedAt']) invalidReactionQueries.push(`FROM callback_reactions WHERE typeof(${column})!='integer' OR ${column}<0 OR ${column}>9007199254740991`);

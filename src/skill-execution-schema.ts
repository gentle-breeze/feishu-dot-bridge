/** Task-sidecar v2 only; Bridge schema is unchanged. */
export const skillExecutionSchema=`CREATE TABLE skill_executions(runId TEXT PRIMARY KEY REFERENCES runs(id),targetKey TEXT NOT NULL,state TEXT NOT NULL,workspace TEXT,baseSha TEXT,manifest TEXT,proposalHash TEXT,commitSha TEXT,remoteSha TEXT,evidence TEXT,error TEXT,updatedAt INTEGER NOT NULL);
CREATE UNIQUE INDEX skill_execution_target ON skill_executions(targetKey) WHERE state IN ('preparing','context_ready','applying','pushing','push_uncertain');`;
export const executionStates=['preparing','context_ready','applying','pushing','push_uncertain','no_change','pushed','conflict','stopped'];

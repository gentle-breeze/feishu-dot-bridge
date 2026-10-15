/** Fixed Git operations against configured targets, never commands supplied by a model. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
import {mkdtempSync,lstatSync,realpathSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import type {z} from 'zod';
import {executorSchema,targetSchema} from './scheduled-review.js';
import {BridgeError} from './types.js';
import {hash} from './crypto.js';
import {classifyText} from './content-safety.js';
export type SkillTarget=z.infer<typeof targetSchema>;
export type ExecutorConfig=z.infer<typeof executorSchema>;
export type GitCall=(cwd:string,args:string[])=>string|Promise<string>;
export type SkillManifest={path:string;sha256:string;content:string}[];
export const validSha=(sha:string)=>/^[a-f0-9]{40}$/.test(sha);
function fail(code:string):never{throw new BridgeError(code);}
function trustedPath(path:string,privateDirectory=false){
 if(realpathSync(path)!==path)fail('skill_path_not_canonical');
 for(let p=path;;p=dirname(p)){const st=lstatSync(p);if(st.isSymbolicLink() || (st.uid!==0&&st.uid!==process.getuid?.()) || ((st.mode&0o022)!==0 && !(st.uid===0&&(st.mode&0o1000))))fail('skill_untrusted_path');if(dirname(p)===p)break;}
 const st=lstatSync(path);if(privateDirectory&&(!st.isDirectory()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o700))fail('skill_private_root_required');
}
function skillName(text:string){const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);if(!front)fail('skill_frontmatter_required');const names=front[1]!.split(/\r?\n/).filter(l=>/^name:/.test(l));if(names.length!==1||!/^name:\s+[A-Za-z0-9_-]+\s*$/.test(names[0]!))fail('invalid_skill_name');if(!/^description:\s+\S/m.test(front[1]!))fail('skill_description_required');return names[0]!.trim();}
function safeContent(text:string){if(!text||Buffer.byteLength(text)>65536||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||classifyText(text)==='credential')fail('unsafe_skill_content');skillName(text);}
export class SkillGitExecutor {
 readonly git:GitCall;
 constructor(readonly config:ExecutorConfig,git?:GitCall){executorSchema.parse(config);if(!config.enabled)fail('skill_executor_disabled');trustedPath(config.workRoot,true);
  if(git){this.git=git;return;}
  trustedPath(config.gitPath);if(!lstatSync(config.gitPath).isFile())fail('invalid_git_executable');
  if(config.ghPath){trustedPath(config.ghPath);if(!lstatSync(config.ghPath).isFile())fail('invalid_credential_helper');}
  this.git=async(cwd,args)=>{const helper=config.ghPath?`!${config.ghPath} auth git-credential`:'';
   let stdout:string;try{const result=await execFileAsync(config.gitPath,['-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','commit.gpgsign=false','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','http.followRedirects=false','-c','http.sslVerify=true','-c','credential.helper=','-c',`credential.helper=${helper}`,...args],{cwd,env:{PATH:dirname(config.gitPath)+':/usr/bin:/bin',HOME:config.workRoot,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1',GIT_ATTR_NOSYSTEM:'1',GIT_LITERAL_PATHSPECS:'1',...(config.ghPath?{GH_CONFIG_DIR:process.env.GH_CONFIG_DIR??join(process.env.HOME??'','.config/gh')}:{})},encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
   stdout=result.stdout;}catch{fail('skill_git_operation_failed');}return args[0]==='show'?stdout:stdout.trimEnd();};
 }
 private checkWorkspace(path:string){if(dirname(path)!==this.config.workRoot || !/^skill-run-[A-Za-z0-9]+$/.test(path.split('/').at(-1)!))fail('skill_workspace_out_of_scope');trustedPath(path,true);}
 private assertFile(workspace:string,path:string){if(resolve(workspace,path)!==join(workspace,path))fail('skill_path_escape');for(let p=join(workspace,path);p!==workspace;p=dirname(p)){const st=lstatSync(p);if(st.isSymbolicLink()|| (p===join(workspace,path)?!st.isFile():!st.isDirectory()))fail('skill_symlink_or_type_rejected');}}
 async remoteSha(workspace:string,target:SkillTarget){this.checkWorkspace(workspace);const text=await this.git(workspace,['ls-remote','--refs',target.remote,'refs/heads/main']);const m=/^([a-f0-9]{40})\s+refs\/heads\/main$/.exec(text);if(!m)fail('skill_remote_main_missing');return m[1]!;}
 async context(target:SkillTarget,authorize:()=>void){targetSchema.parse(target);authorize();trustedPath(target.repository);trustedPath(join(target.repository,'.git'));if(!lstatSync(join(target.repository,'.git')).isDirectory()||lstatSync(join(target.repository,'.git')).isSymbolicLink())fail('skill_repository_type_rejected');
  // Identity read only; never checkout, stash, reset or commit in the operator's checkout.
  if(await this.git(target.repository,['config','--local','--get','remote.origin.url'])!==target.remote)fail('skill_repository_remote_mismatch');
  const workspace=mkdtempSync(join(this.config.workRoot,'skill-run-'));await this.git(workspace,['init','--quiet']);authorize();
  await this.git(workspace,['fetch','--no-tags','--no-recurse-submodules',target.remote,'refs/heads/main']);const baseSha=await this.git(workspace,['rev-parse','FETCH_HEAD']);if(!validSha(baseSha))fail('skill_invalid_base');
  // Materialize only regular allowlisted skill files. No checkout/filter/submodule code executes.
  const manifest:SkillManifest=[];
  for(const path of target.files){const entry=await this.git(workspace,['ls-tree',baseSha,'--',path]);if(!new RegExp('^100644 blob [a-f0-9]{40}\\t'+path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$').test(entry))fail('skill_file_not_regular_tracked');
    const content=await this.git(workspace,['show',`${baseSha}:${path}`]);safeContent(content);manifest.push({path,sha256:hash(content),content});}
  if(Buffer.byteLength(JSON.stringify(manifest))>180000)fail('skill_context_too_large');
  await this.git(workspace,['read-tree',baseSha]);return {workspace,baseSha,manifest};
 }
 async stage(workspace:string,target:SkillTarget,baseSha:string,manifest:SkillManifest,changes:{path:string;content:string}[],authorize:()=>void){this.checkWorkspace(workspace);targetSchema.parse(target);if(!validSha(baseSha)||await this.git(workspace,['rev-parse',`${baseSha}^{commit}`])!==baseSha)fail('skill_base_missing');
  if(new Set(changes.map(c=>c.path)).size!==changes.length)fail('duplicate_skill_path');
  const meaningful=[] as {path:string;content:string}[];
  for(const change of changes){const old=manifest.find(m=>m.path===change.path);if(!old||!target.files.includes(change.path))fail('skill_path_not_allowed');safeContent(change.content);if(skillName(change.content)!==skillName(old.content))fail('skill_identity_changed');if(change.content!==old.content)meaningful.push(change);}
  authorize();if(await this.remoteSha(workspace,target)!==baseSha)fail('skill_remote_conflict');
  if(!meaningful.length)return {noChange:true as const,baseSha,files:[]};
  for(const change of meaningful){const full=join(workspace,change.path);let parent=workspace;for(const part of change.path.split('/').slice(0,-1)){parent=join(parent,part);if(existsSync(parent)){const st=lstatSync(parent);if(st.isSymbolicLink()||!st.isDirectory())fail('skill_symlink_rejected');}else mkdirSync(parent,{mode:0o700});}
    // Exclusive creation: an existing unexpected file/symlink is not overwritten.
    writeFileSync(full,change.content,{mode:0o600,flag:'wx'});this.assertFile(workspace,change.path);
    const blob=await this.git(workspace,['hash-object','-w','--no-filters','--',change.path]);if(!validSha(blob))fail('skill_invalid_blob');await this.git(workspace,['update-index','--add','--cacheinfo','100644',blob,change.path]);}
  const paths=(await this.git(workspace,['diff','--no-ext-diff','--no-textconv','--cached','--name-only',baseSha])).split('\n').filter(Boolean).sort();if(JSON.stringify(paths)!==JSON.stringify(meaningful.map(c=>c.path).sort()))fail('skill_changed_paths_mismatch');
  await this.git(workspace,['diff','--no-ext-diff','--no-textconv','--cached','--check',baseSha]);const tree=await this.git(workspace,['write-tree']);
  authorize();const commitSha=await this.git(workspace,['-c',`user.name=${this.config.authorName}`,'-c',`user.email=${this.config.authorEmail}`,'commit-tree',tree,'-p',baseSha,'-m','Update configured review skill from scheduled review']);
  if(!validSha(commitSha)||await this.git(workspace,['rev-parse',`${commitSha}^`])!==baseSha)fail('skill_commit_parent_mismatch');
  return {noChange:false as const,baseSha,commitSha,files:meaningful.map(c=>({path:c.path,before:manifest.find(m=>m.path===c.path)!.sha256,after:hash(c.content)}))};
 }
 async push(workspace:string,target:SkillTarget,baseSha:string,commitSha:string,authorize:()=>void){this.checkWorkspace(workspace);authorize();if(await this.git(workspace,['rev-parse',`${commitSha}^`])!==baseSha)fail('skill_commit_parent_mismatch');if(await this.remoteSha(workspace,target)!==baseSha)fail('skill_remote_conflict');authorize();
  // Explicit expected old SHA + exactly-one-child commit: atomic compare-and-swap, never overwrite concurrent main.
  await this.git(workspace,['push','--porcelain',`--force-with-lease=refs/heads/main:${baseSha}`,target.remote,`${commitSha}:refs/heads/main`]);
 }
 async verify(workspace:string,target:SkillTarget,commitSha:string){const remoteSha=await this.remoteSha(workspace,target);if(remoteSha===commitSha)return {verified:true,remoteSha};
  await this.git(workspace,['fetch','--no-tags','--no-recurse-submodules',target.remote,'refs/heads/main']);const fetched=await this.git(workspace,['rev-parse','FETCH_HEAD']);if(fetched!==remoteSha)return {verified:false,remoteSha};
  try{await this.git(workspace,['merge-base','--is-ancestor',commitSha,remoteSha]);return {verified:true,remoteSha};}catch{return {verified:false,remoteSha};}
 }
}

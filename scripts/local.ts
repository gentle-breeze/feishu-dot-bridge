/** Noninteractive JSON-line CLI: no credentials, database access or subscription creation. */
import { localRequest } from '../src/local-socket.js';
import { BridgeError } from '../src/types.js';
try {
  if(process.argv.length!==3)throw new BridgeError('usage_local_socket_path_json_on_stdin');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of process.stdin) {const b=Buffer.from(chunk);size+=b.length;if(size>65536)throw new BridgeError('request_too_large');chunks.push(b);}
  const response=await localRequest(process.argv[2]!,JSON.parse(Buffer.concat(chunks).toString('utf8')));
  console.log(JSON.stringify(response));if((response as {error?:string}).error)process.exitCode=1;
} catch(e) {console.error(JSON.stringify({error:e instanceof BridgeError?e.code:'local_request_failed'}));process.exitCode=1;}

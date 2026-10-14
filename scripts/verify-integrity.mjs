import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const root=process.argv[2]??'dist',html=readFileSync(join(root,'index.html'),'utf8');
let count=0;
for(const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)){
 if(!tag.startsWith('<script')&&!/rel="(?:stylesheet|modulepreload)"/.test(tag))continue;
 const file=tag.match(/(?:src|href)="\/([^"?#]+)"/)?.[1], expected=tag.match(/integrity="([^"]+)"/)?.[1];
 if(!file||!expected)throw new Error('Missing subresource integrity: '+tag);
 const actual='sha384-'+createHash('sha384').update(readFileSync(join(root,file))).digest('base64');
 if(actual!==expected)throw new Error('Integrity mismatch: '+file);
 count++;
}
if(count<2)throw new Error('No script/style integrity entries');
console.log(`Verified ${count} script/style integrity hashes against built bytes`);

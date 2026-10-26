// Fresh witnesses built with maintained Noble point/scalar operations.
// Torsion generators: @noble/curves 2.2.0 ED25519_TORSION_SUBGROUP (MIT).
import {ed25519,ED25519_TORSION_SUBGROUP} from '@noble/curves/ed25519.js';
import {sha512} from '@noble/hashes/sha2.js';
import {verifyEd25519} from '../../src/signature';
import {authorCarrierOp,verifyCarrierOp,canonicalBase64Bytes} from '../../src/codec';
import {readFileSync} from 'node:fs';
const b64=(v:Uint8Array)=>Buffer.from(v).toString('base64');
const le=(v:Uint8Array)=>BigInt('0x'+Buffer.from(v).reverse().toString('hex'));
const scalar=(v:bigint)=>Uint8Array.from(Buffer.from(v.toString(16).padStart(64,'0'),'hex').reverse());
const concat=(...v:Uint8Array[])=>Uint8Array.from(Buffer.concat(v));
const bytes=(v:string)=>new TextEncoder().encode(v);
interface Case{name:string;key:string;message:string;signature:string;expected:boolean}
if(process.argv[2]==='consume'){
 const input=JSON.parse(readFileSync(process.argv[3]??0,'utf8')) as {cases:Case[]};
 console.log(JSON.stringify({decisions:input.cases.map(v=>{try{return verifyEd25519(Buffer.from(v.signature,'base64'),Buffer.from(v.message,'base64'),Buffer.from(v.key,'base64'));}catch{return false;}})}));
}else{
 const cases:Case[]=[];
 const add=(name:string,key:Uint8Array,message:Uint8Array,signature:Uint8Array,expected:boolean)=>cases.push({name,key:b64(key),message:b64(message),signature:b64(signature),expected});
 const seed=sha512(bytes('strict-signature-ts-producer')).slice(0,32),extended=ed25519.utils.getExtendedPublicKey(seed);
 const message=bytes('fresh strict signature reciprocal message'),key=ed25519.getPublicKey(seed),valid=ed25519.sign(message,seed);
 add('valid-generated',key,message,valid,true);
 for(let i=0;i<16;i++){const seed=sha512(bytes('independent-valid-'+i)).slice(0,32),msg=new Uint8Array(i===0?0:i*71).fill(i);add('valid-fresh-'+i,ed25519.getPublicKey(seed),msg,ed25519.sign(msg,seed),true);}
 for(let i=2n;i<100n;i++){try{ed25519.Point.fromBytes(scalar(i),false);}catch{add('off-curve-key',scalar(i),message,valid,false);break;}}
add('wrong-message',key,bytes('other message'),valid,false);
 add('wrong-key',ed25519.getPublicKey(new Uint8Array(32).fill(81)),message,valid,false);
 const torsion=ED25519_TORSION_SUBGROUP.map(v=>ed25519.Point.fromHex(v)),n=ed25519.Point.Fn.ORDER;
 for(const [i,point]of torsion.entries())add('weak-key-'+i,point.toBytes(),message,concat(torsion[0]!.toBytes(),scalar(0n)),false);
 // Both true/false uncofactored equations for mixed-order keys and all R classes.
 for(const aT of [0,1,2,3,4,5,6,7])for(const [rT,T]of torsion.entries()){
  const A=extended.point.add(torsion[aT]!),publicKey=A.toBytes(),R=ed25519.Point.BASE.multiply(37n).add(T),r=R.toBytes();
  const k=le(sha512(concat(r,publicKey,message)))%n,s=(37n+k*extended.scalar)%n;
  const expected=!A.isSmallOrder()&&!R.isSmallOrder()&&ed25519.Point.BASE.multiplyUnsafe(s).equals(R.add(A.multiplyUnsafe(k)));
  add(`mixed-A${aT}-R${rT}`,publicKey,message,concat(r,scalar(s)),expected);
 }
 for(const [i,T]of torsion.entries()){
  const r=T.toBytes(),k=le(sha512(concat(r,key,message)))%n;
  add('small-order-R-'+i,key,message,concat(r,scalar(k*extended.scalar%n)),false);
 }

 // Universal forgeries with non-small R isolate weak/canonical A checks.
 const rawKeys=[...torsion.map(point=>point.toBytes()),scalar(1n|(1n<<255n)),scalar(((1n<<255n)-19n)+1n),scalar((((1n<<255n)-19n)+1n)|(1n<<255n))];
 for(const [index,rawKey]of rawKeys.entries()){
  const point=ed25519.Point.fromBytes(rawKey,true);let found=false;
  for(let nonce=1n;nonce<256n;nonce++){
   const r=ed25519.Point.BASE.multiply(nonce).toBytes(),k=le(sha512(concat(r,rawKey,message)))%n;
   if(point.multiplyUnsafe(k).equals(ed25519.Point.ZERO)){add('isolated-weak-or-noncanonical-A-'+index,rawKey,message,concat(r,scalar(nonce)),false);found=true;break;}
  }
  if(!found)throw new Error('bounded isolated-A witness search');
 }
 for(const s of [0n,n,n+1n,le(valid.slice(32))+n,le(valid.slice(32))+8n*n,(1n<<256n)-1n])add('scalar-'+s,key,message,concat(valid.slice(0,32),scalar(s)),false);
 for(const size of [0,31,33])add('key-length-'+size,new Uint8Array(size),message,valid,false);
 for(const size of [0,63,65])add('signature-length-'+size,key,message,new Uint8Array(size),false);
 const p=(1n<<255n)-19n;
 for(const y of [1n,p-1n,p,p+1n,(1n<<255n)-1n])for(const sign of [0n,1n]){
  const point=scalar(y|(sign<<255n));
  add(`noncanonical-key-${y}-${sign}`,point,message,concat(torsion[0]!.toBytes(),scalar(0n)),false);
  add(`noncanonical-R-${y}-${sign}`,key,message,concat(point,valid.slice(32)),false);
 }
 const r=ed25519.Point.BASE.multiply(37n).toBytes(),forged=concat(r,scalar(37n)),identity=torsion[0]!.toBytes();
 const make=(publicKey:Uint8Array,sign:(v:Uint8Array)=>Uint8Array)=>authorCarrierOp({replica:'strict-signature-frame',signer:{publicKey,sign},deps:[],kind:'command',cap:['nil'],body:['nil']});
 const frames=[{frame:await make(identity,()=>forged),expected:false},{frame:await make(key,v=>ed25519.sign(v,seed)),expected:true}];
 // Public authentication path, independently of detached consent checks.
 for(const {frame,expected}of frames){const result=await verifyCarrierOp(frame,{verify:async(pub,bytes,sig)=>verifyEd25519(sig,bytes,canonicalBase64Bytes(pub,32)!)});if(result.valid!==expected)throw new Error('strict public frame authentication mismatch');}
 console.log(JSON.stringify({cases,frames}));
}

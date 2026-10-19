import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransfer, buildSendCalldata, TRANSFERRED_TOPIC, PHASE } from '../src/transfer.js';
const A='0x'+'1'.repeat(40), R='0x'+'2'.repeat(40), C='0x'+'3'.repeat(40), H='0x'+'a'.repeat(64);
const amount=10n**18n, code='0x6080dead', chain='0x4cef52';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const receipt=()=>({transactionHash:H,status:'0x1',logs:[{address:C,topics:[TRANSFERRED_TOPIC,...[A,R].map(a=>'0x'+a.slice(2).padStart(64,'0'))],data:'0x'+amount.toString(16).padStart(64,'0')}]});
const tx=()=>({hash:H,from:A,to:C,value:'0x'+amount.toString(16),input:buildSendCalldata(R)});
function provider(overrides={}) {
  const calls=[];
  return { calls, on(){},removeListener(){}, async request({method,params}) {
    calls.push(method);
    if(method in overrides) return overrides[method](params);
    return ({eth_chainId:chain,eth_accounts:[A],eth_getCode:code,eth_estimateGas:'0x10000',eth_gasPrice:'0x1',eth_getBalance:'0x10000000000000000000',eth_sendTransaction:H,eth_getTransactionReceipt:receipt(),eth_getTransactionByHash:tx()})[method];
  }};
}
async function ready(overrides={}) {
  const p=provider(overrides), gate=deferred(), reached=deferred();let first=true;
  const t=createTransfer(C,code,()=>{},{waitForPoll:()=>{if(first){first=false;reached.resolve();return gate.promise;}return Promise.resolve();}});
  await t.setProvider(p);assert.equal((await t.review(R,'1')).ok,true);
  const send=t.send();await reached.promise;
  return {t,p,send,gate};
}
async function submitted() {const c=await ready();c.t.reset();c.gate.resolve();await c.send;return c;}
for(const action of ['reset','provider','review']) for(const response of ['resolve','reject']) {
  test(`R6 chain check ${response} after ${action} cannot publish`,{timeout:2000},async()=>{
    const {t}=await submitted(), chainDef=deferred(), entered=deferred();
    const q=provider({eth_chainId:()=>{entered.resolve();return chainDef.promise;}});
    const pending=t.confirmResult(q);await entered.promise;
    if(action==='reset')t.reset();
    if(action==='provider')await t.setProvider(provider());
    if(action==='review')assert.equal((await t.review(R,'2')).ok,true);
    const before=t.getState();
    response==='resolve'?chainDef.resolve(chain):chainDef.reject(new Error('late failure'));
    await pending;assert.deepEqual(t.getState(),before);
    assert.equal(q.calls.includes('eth_getTransactionReceipt'),false);
  });
}
const mutations=[
  ['numeric receipt',()=>42],['array receipt',()=>[]],
  ['numeric receipt hash',()=>({...receipt(),transactionHash:123})],
  ['invalid log data',()=>{const r=receipt();r.logs[0].data='NOT_HEX';return r;}],
  ['null log',()=>({...receipt(),logs:[null]})],
  ['numeric topic',()=>{const r=receipt();r.logs[0].topics[1]=42;return r;}],
  ['non-array logs',()=>({...receipt(),logs:{}})],
];
for(const [name,make] of mutations) test(`R6 malformed ${name} releases confirmation owner`,{timeout:2000},async()=>{
  const {t,send,gate}=await ready({eth_getTransactionReceipt:async()=>make()});gate.resolve();await send;
  const s=t.getState();assert.equal(s.phase,PHASE.FAILED);assert.equal(s.busy,false);assert.equal(t._getBusyOwner(),0);assert.equal(s.txHash,H);
});
for(const [name,badTx] of [['hash',{...tx(),hash:1}],['from',{...tx(),from:123}],['input',{...tx(),input:42}],['value',{...tx(),value:'bad'}]]) {
  test(`R6 malformed tx ${name} releases confirmation owner`,{timeout:2000},async()=>{
    const {t,send,gate}=await ready({eth_getTransactionByHash:async()=>badTx});gate.resolve();await send;
    assert.equal(t.getState().phase,PHASE.FAILED);assert.equal(t.getState().busy,false);
  });
}
test('R6 valid receipt still succeeds',{timeout:2000},async()=>{const {t,send,gate}=await ready();gate.resolve();await send;assert.equal(t.getState().phase,PHASE.SUCCESS);assert.equal(t.getState().busy,false);});
test('R6 confirmResult malformed receipt releases own token',{timeout:2000},async()=>{const {t}=await submitted();await t.confirmResult(provider({eth_getTransactionReceipt:async()=>42}));assert.equal(t.getState().phase,PHASE.FAILED);assert.equal(t.getState().busy,false);});
test('R6 stale rejected tx RPC cannot touch new review',{timeout:2000},async()=>{
  const body=deferred(),entered=deferred();const {t,send,gate}=await ready({eth_getTransactionByHash:()=>{entered.resolve();return body.promise;}});
  gate.resolve();await entered.promise;t.reset();await t.review(R,'2');const before=t.getState();body.reject(new Error('old RPC'));await send;assert.deepEqual(t.getState(),before);
});
test('R6 stale preflight after completed review preserves all fields',{timeout:2000},async()=>{
  const gate=deferred(),entered=deferred();let n=0;
  const p=provider({eth_getCode:()=>{if(++n===2){entered.resolve();return gate.promise;}return code;}});
  const t=createTransfer(C,code);await t.setProvider(p);await t.review(R,'1');const send=t.send();await entered.promise;
  t.reset();await t.review(A,'2');const before=t.getState();gate.resolve(code);await send;assert.deepEqual(t.getState(),before);assert.equal(p.calls.includes('eth_sendTransaction'),false);
});
test('R6 cancelled preflight never submits transaction',{timeout:2000},async()=>{
  const gate=deferred(),entered=deferred();let n=0;
  const p=provider({eth_getCode:()=>{if(++n===2){entered.resolve();return gate.promise;}return code;}});
  const t=createTransfer(C,code);await t.setProvider(p);await t.review(R,'1');const send=t.send();await entered.promise;t.cancelReview();gate.resolve(code);await send;
  assert.equal(p.calls.includes('eth_sendTransaction'),false);assert.equal(t.getState().busy,false);
});
test('R6 stale review cannot release preflight busy owner',{timeout:2000},async()=>{
  const codeGate=deferred(),codeReached=deferred(),chainGate=deferred(),chainReached=deferred();let n=0,stall=false;
  const p=provider({eth_getCode:()=>{if(++n===1){codeReached.resolve();return codeGate.promise;}return code;},eth_chainId:()=>{if(stall){chainReached.resolve();return chainGate.promise;}return chain;}});
  const t=createTransfer(C,code);await t.setProvider(p);const old=t.review(R,'1');await codeReached.promise;t.cancelReview();await t.review(R,'2');stall=true;
  const send=t.send();await chainReached.promise;const before=t.getState();codeGate.resolve(code);await old;assert.deepEqual(t.getState(),before);t.reset();chainGate.resolve(chain);await send;
});
test('R6 stale receipt cannot release new confirmation owner',{timeout:2000},async()=>{
  const oldGate=deferred(),oldReached=deferred(),newGate=deferred(),newReached=deferred();let n=0;
  const p=provider({eth_getTransactionReceipt:()=>{if(++n===1){oldReached.resolve();return oldGate.promise;}newReached.resolve();return newGate.promise;}});
  const t=createTransfer(C,code,()=>{},{waitForPoll:()=>Promise.resolve()});await t.setProvider(p);await t.review(R,'1');const send=t.send();await oldReached.promise;t.reset();const confirm=t.confirmResult(p);await newReached.promise;
  const before=t.getState();oldGate.resolve(receipt());await send;assert.deepEqual(t.getState(),before);newGate.resolve(receipt());await confirm;assert.equal(t.getState().phase,PHASE.SUCCESS);
});
// ── RPC-DIAG-2: rpc() wrapper propagates method name and code to UI error ──
for (const [method, params, override] of [
  ['eth_chainId',    [], ()=>{ throw Object.assign(new Error('chain error'), {code:-32001}); }],
  ['eth_accounts',   [], ()=>{ throw Object.assign(new Error('accounts error'), {code:-32002}); }],
  ['eth_getCode',    [C,'latest'], ()=>{ throw Object.assign(new Error('code error'), {code:-32003}); }],
  ['eth_estimateGas',[], ()=>{ throw Object.assign(new Error('estimate error'), {code:-32603}); }],
  ['eth_gasPrice',   [], ()=>{ throw Object.assign(new Error('price error'), {code:-32004}); }],
  ['eth_getBalance', [], ()=>{ throw Object.assign(new Error('balance error'), {code:-32005}); }],
]) {
  test(`RPC-DIAG-2: ${method} failure surfaces method name and code in state.error`, {timeout:2000}, async () => {
    // eth_chainId/eth_accounts failures need to be injected for ALL calls
    // (including setProvider's initial read); for the others the first N-1 calls succeed.
    let callCount = 0;
    const p = provider({ [method]: (...a) => { callCount++; return override(...a); } });
    const t = createTransfer(C, code);
    await t.setProvider(p);
    // For methods that also fire during setProvider (eth_chainId, eth_accounts),
    // reset the error so we test the review() path cleanly.
    if (method === 'eth_chainId' || method === 'eth_accounts') {
      t.reset();
      // rebuild a provider that returns valid on setProvider but throws on review()
      let providerCallCount = 0;
      const p2 = provider({ [method]: (...a) => {
        providerCallCount++;
        if (providerCallCount <= 1) return method === 'eth_chainId' ? chain : [A];
        throw Object.assign(new Error(method + ' error'), {code: method === 'eth_chainId' ? -32001 : -32002});
      }});
      await t.setProvider(p2);
    }
    const result = await t.review(R, '1');
    assert.equal(result.ok, false, 'review should fail');
    const errMsg = t.getState().error;
    assert.ok(errMsg.includes(method), `error "${errMsg}" should contain method name "${method}"`);
    const codeStr = method === 'eth_chainId' ? '-32001'
      : method === 'eth_accounts' ? '-32002'
      : method === 'eth_getCode' ? '-32003'
      : method === 'eth_estimateGas' ? '-32603'
      : method === 'eth_gasPrice' ? '-32004'
      : '-32005';
    assert.ok(errMsg.includes(codeStr), `error "${errMsg}" should contain code "${codeStr}"`);
    assert.equal(t.getState().busy, false, 'busy must be false after review failure');
  });
}

// ── RPC-DIAG-3: balance read before estimateGas; nested err.data extraction ──
test('DIAG-3: reviewedBalance is set even when eth_estimateGas fails', {timeout:2000}, async () => {
  const BALANCE_HEX = '0x' + (5n * 10n**18n).toString(16); // 5 USDC
  const p = provider({
    eth_getBalance: () => BALANCE_HEX,
    eth_estimateGas: () => { throw Object.assign(new Error('estimate error'), {code:-32603}); },
  });
  const t = createTransfer(C, code);
  await t.setProvider(p);
  const result = await t.review(R, '1');
  assert.equal(result.ok, false);
  const s = t.getState();
  // Balance must be available despite estimateGas failure
  assert.equal(s.reviewedBalance, 5n * 10n**18n, 'reviewedBalance must be set before estimateGas');
  assert.ok(s.error.includes('eth_estimateGas'), 'error must name the failing method');
  assert.ok(s.error.includes('-32603'), 'error must include the RPC code');
  assert.equal(s.busy, false);
});

test('DIAG-3: nested err.data.originalError is extracted', {timeout:2000}, async () => {
  // MetaMask sometimes wraps the real error: { message, data: { originalError: { code, message } } }
  const nestedErr = Object.assign(new Error('MetaMask outer'), {
    code: -32603,
    data: { originalError: { code: -32000, message: 'insufficient funds for gas' } },
  });
  const p = provider({ eth_estimateGas: () => { throw nestedErr; } });
  const t = createTransfer(C, code);
  await t.setProvider(p);
  const result = await t.review(R, '1');
  assert.equal(result.ok, false);
  const errMsg = t.getState().error;
  assert.ok(errMsg.includes('eth_estimateGas'), 'method name in error');
  // The inner code (-32000) should be extracted from originalError
  assert.ok(errMsg.includes('-32000') || errMsg.includes('insufficient funds'), `inner detail in error: "${errMsg}"`);
  assert.equal(t.getState().busy, false);
});

test('DIAG-3: transfer-r6.js and transfer.js are byte-identical', {timeout:2000}, async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const dir = new URL('../src/', import.meta.url).pathname;
  const h1 = createHash('sha256').update(readFileSync(dir + 'transfer.js')).digest('hex');
  const h2 = createHash('sha256').update(readFileSync(dir + 'transfer-r6.js')).digest('hex');
  assert.equal(h1, h2, 'transfer.js and transfer-r6.js must be byte-identical');
});

test('R6 wallet prompt remains locked across cancellation and rejection',{timeout:2000},async()=>{
  const gate=deferred(),entered=deferred();const p=provider({eth_sendTransaction:()=>{entered.resolve();return gate.promise;}});
  const t=createTransfer(C,code);await t.setProvider(p);await t.review(R,'1');const send=t.send();await entered.promise;t.reset();assert.equal((await t.review(R,'2')).ok,false);await t.send();assert.equal(p.calls.filter(x=>x==='eth_sendTransaction').length,1);
  gate.reject(Object.assign(new Error('rejected'),{code:4001}));await send;assert.equal(t.getState().phase,PHASE.IDLE);assert.equal(t.getState().busy,false);assert.equal(t.getState().reviewedAmount,null);
});

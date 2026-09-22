import { normalizeDocumentSource } from '../src/source-fingerprint.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPortableSha256 } from '../src/portable-sha256.mjs';
import { nativeTextRuntime, decodeUtf8Envelope } from '../src/gateway-client.mjs';

test('self-contained bundled SHA256 matches Node across block edges and Unicode', () => {
  const sha = Function('return (' + createPortableSha256.toString() + ')()')();
  for (const length of [0,1,55,56,63,64,65,127,128,4096,362000]) {
    const bytes = Uint8Array.from({length}, (_,i) => (i*17+239)%256);
    assert.equal(Buffer.from(sha(bytes)).toString('hex'), createHash('sha256').update(bytes).digest('hex'));
  }
  const text = new TextEncoder().encode('\uFEFF测试PCB网表');
  assert.equal(Buffer.from(sha(text)).toString('hex'), createHash('sha256').update(text).digest('hex'));
});

test('legacy native UTF8 export does not rely on missing sandbox WebCrypto', async () => {
  const target={windowId:'w',projectUuid:'p',documentUuid:'d',tabId:'t'};
  const text='\uFEFF器件: 39\n元件: 总计 107';
  const eda={
    dmt_SelectControl:{getCurrentDocumentInfo:async()=>({documentType:3,uuid:'d',tabId:'t'})},
    dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'p'})},
    sys_FileManager:{getDocumentSource:async()=>'stable-source'},
    pcb_ManufactureData:{getPcbInfoFile:async()=>new File([text],'fixture.txt')},
  };
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{}});
  try {
    const envelope=await nativeTextRuntime(eda,{target,kind:'boardInfo',maximumBytes:1048576},createPortableSha256(),normalizeDocumentSource);
    assert.equal(decodeUtf8Envelope(envelope,1048576).toString('utf8'),text);
    assert.equal(envelope.sourceHash,createHash('sha256').update('stable-source').digest('hex'));
  } finally {Object.defineProperty(globalThis,'crypto',descriptor);}
});

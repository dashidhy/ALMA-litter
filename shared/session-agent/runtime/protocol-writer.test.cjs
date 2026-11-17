'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {Writable}=require('node:stream');
const {createProtocolWriter}=require('./protocol-writer.cjs');
test('large frames remain whole and ordered through asynchronous backpressure',async()=>{
 const chunks=[];const stream=new Writable({highWaterMark:16,write(chunk,_encoding,done){setTimeout(()=>{chunks.push(Buffer.from(chunk));done();},2);}});
 const writer=createProtocolWriter('P',{stream,frameLimit:()=>4*1024*1024,queueLimit:8*1024*1024});
 const first={kind:'http',id:1,body:'中文🌏'.repeat(120000)};
 writer.send(first);writer.send({kind:'event',id:2});writer.send({kind:'terminal'});
 await writer.flush();const lines=Buffer.concat(chunks).toString().trimEnd().split('\n');
 assert.deepEqual(lines.map(line=>JSON.parse(line.slice(1))),[first,{kind:'event',id:2},{kind:'terminal'}]);
});
test('an output error rejects closure and does not pretend later frames were sent',async()=>{
 let writes=0;const stream=new Writable({write(_chunk,_encoding,done){writes++;done(new Error('broken_pipe'));}});
 const writer=createProtocolWriter('P',{stream});writer.send({kind:'http'});writer.send({kind:'terminal'});
 await assert.rejects(writer.flush(),/broken_pipe/);assert.equal(writes,1);
});

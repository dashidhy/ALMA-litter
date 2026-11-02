import Foundation
import JavaScriptCore
import Darwin

/// Compare the actual bundled Buffer/TextCodec overloads with native hooks on/off.
/// No provider, credentials, journal, network or device calls are admitted.
@main struct CodecIntegrationChecks {
    static func run(bundle: String, native: Bool) async throws -> String {
        let host = try await AlmaTAHJavaScriptHost(bundle: bundle, platform: { _, _ in
            throw NSError(domain: "UnexpectedPlatformCall", code: 1)
        }, enableNativeBytePrimitives: native)
        try await host.evaluate(#"""
        globalThis.AlmaMobileRuntime={invoke:async()=>{
          const result=[];
          const add=(label,body)=>{try{result.push({label,value:body()});}catch(e){result.push({label,error:e.name});}};
          const strings=['','plain text','中文 English 日本語 한국어','é\uFEFF🙂𐐀','\uD800','\uDC00','\uD800\uD800','a\uDC00b','\uFFFD','\u0000x'];
          for(const [i,s]of strings.entries()){
            for(const enc of [undefined,'utf8','UTF8','utf-8','hex','base64','base64url','BASE64URL','latin1']){
              add(`from/${i}/${enc}`,()=>{const b=Buffer.from(s,enc);return {hex:b.toString('hex'),buffer:Buffer.isBuffer(b),type:b.constructor.name};});
              add(`length/${i}/${enc}`,()=>Buffer.byteLength(s,enc));
              add(`length-strict/${i}/${enc}`,()=>Buffer.byteLength(s,enc,true));
            }
            add(`encoder/${i}`,()=>Array.from(new TextEncoder().encode(s)));
          }
          const byteCases=[[],[0],[0xef,0xbb,0xbf,65],[0xef,0xbf,0xbd],[0xe2,0x82],[0xf0,0x9f,0x92],[0xc0,0x80],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],Array.from({length:1024},(_,i)=>(i*73)%256)];
          for(let i=0;i<256;i++)byteCases.push([i]);
          for(const [i,bytes]of byteCases.entries()){
            const base=Buffer.from([9,8,...bytes,7,6]);const b=base.subarray(2,2+bytes.length);
            for(const enc of [undefined,'utf8','UTF-8','base64','BASE64','base64url','BASE64URL','hex']){
              add(`string/${i}/${enc}`,()=>b.toString(enc));
              add(`slice/${i}/${enc}`,()=>b.toString(enc,1,5));
            }
            for(const fatal of [false,true])add(`decoder/${i}/${fatal}`,()=>new TextDecoder('utf-8',{fatal}).decode(b));
            add(`roundtrip/${i}`,()=>Buffer.from(b.toString('base64'),'base64').toString('hex'));
          }
          for(const s of ['TQ==','TWE=','TWFu','TQ','TQ=','TQ===','TR==','TWG=',' TQ==\n','@@TQ==','-_8=','a','é'])
            add(`base64/${s}`,()=>Buffer.from(s,'base64').toString('hex'));
          add('view',()=>new TextDecoder().decode(new DataView(Uint8Array.from([9,65,66,8]).buffer,1,2)));
          if(typeof SharedArrayBuffer!=='undefined')add('shared',()=>{const a=new Uint8Array(new SharedArrayBuffer(3));a.set([65,66,67]);return Buffer.from(a.buffer).toString('utf8');});
          add('resizable',()=>{const storage=new ArrayBuffer(4,{maxByteLength:16});const a=new Uint8Array(storage);a.set([65,66,67,68]);const b=Buffer.from(storage,1,2);return {text:b.toString('utf8'),base64:b.toString('base64'),decoded:new TextDecoder().decode(b)};});
          if(typeof ArrayBuffer.prototype.transfer==='function')add('detached-empty',()=>{const a=new Uint8Array(3);const b=Buffer.from(a.buffer);a.buffer.transfer();return b.toString('utf8');});
          add('borrowed-toString',()=>Buffer.prototype.toString.call({length:1,0:65},'utf8'));
          for(const fill of [0,-0,1,255,256,NaN,undefined,'ab']){
            add(`fill/${String(fill)}`,()=>{const parent=Buffer.from([1,2,3,4]);const part=parent.subarray(1,3);const returned=part.fill(fill);return {bytes:Array.from(parent),identity:returned===part};});
            add(`fill-range/${String(fill)}`,()=>Array.from(Buffer.from([1,2,3,4]).fill(fill,1,3)));
          }
          add('fill-empty',()=>Array.from(Buffer.alloc(0).fill(0)));
          if(typeof ArrayBuffer.prototype.transfer==='function')add('fill-detached',()=>{const b=Buffer.from([1,2]);b.buffer.transfer();return b.fill(0)===b;});
          add('fill-borrowed',()=>{const o={length:2};Buffer.prototype.fill.call(o,0);return o;});
          return result;
        }};
        """#)
        let result = try await host.invoke("cases", json: "{}")
        await host.shutdown()
        return result
    }

    static func main() async throws {
        let bundle = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        let baseline = try await run(bundle: bundle, native: false)
        let accelerated = try await run(bundle: bundle, native: true)
        let a = try JSONSerialization.jsonObject(with: Data(baseline.utf8)) as! [[String: Any]]
        let b = try JSONSerialization.jsonObject(with: Data(accelerated.utf8)) as! [[String: Any]]
        let differences = zip(a,b).compactMap { left,right -> [String:Any]? in
            NSDictionary(dictionary:left).isEqual(to:right) ? nil : ["baseline":left,"native":right]
        }
        let report: [String:Any] = ["passed":a.count == b.count && differences.isEmpty,
                                   "checks":a.count,"differences":differences,"providerCalls":0]
        let data = try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys])
        FileHandle.standardOutput.write(data + Data([10]))
        if !differences.isEmpty || a.count != b.count { exit(1) }
    }
}

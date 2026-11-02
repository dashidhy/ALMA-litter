// Standalone, no production Host/shim or source-list changes required.
// From repo root (all generated output stays in .cache):
// mkdir -p .cache/jscore-byte
// swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -O \
//   -module-cache-path .cache/jscore-byte/modules \
//   apps/ios/Sources/AlmaTAH/Runtime/TAHJavaScriptBytePrimitives.swift \
//   tools/mobile-tah/jscore_byte_checks.swift -o .cache/jscore-byte/checks
// JSC_useJIT=false .cache/jscore-byte/checks [--benchmark]
// Also typecheck with -swift-version 5 and the same strict/warnings flags.
// Node must be on PATH. It supplies an independent Buffer/TextDecoder/crypto oracle.
import Dispatch
import Foundation
import JavaScriptCore

@main
struct JSCoreByteChecks {
    enum CheckError: Error { case failed(String) }

    static func main() async throws {
        // Every context is created, installed, evaluated and released inside this
        // serial worker. Only Foundation values leave it; no @unchecked Sendable.
        let output: String = try await withCheckedThrowingContinuation { continuation in
            DispatchQueue(label: "alma.byte-checks").async {
                do { continuation.resume(returning: try run()) }
                catch { continuation.resume(throwing: error) }
            }
        }
        print(output)
    }

    static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw CheckError.failed(message) }
    }

    static func evaluate(_ context: JSContext, _ script: String) throws -> JSValue {
        context.exception = nil
        let result = context.evaluateScript(script)
        if let exception = context.exception { throw CheckError.failed(exception.toString() ?? "JS exception") }
        guard let result else { throw CheckError.failed("Missing result") }
        return result
    }

    static func nodeOracle() throws -> String {
        let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        // Feed UTF-8 over stdin. macOS Process argv filesystem conversion can
        // normalize Unicode, which would corrupt the independent string oracle.
        process.arguments = ["node", "-"]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        input.fileHandleForWriting.write(Data(("const native = false;\n" + fixtures + "\nprocess.stdout.write(JSON.stringify(records));").utf8))
        try input.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try require(process.terminationStatus == 0,
                    "Node oracle failed: " + String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
        return String(decoding: data, as: UTF8.self)
    }

    static func run() throws -> String {
        let oracle = try nodeOracle()
        var report: [String: Any] = ["passed": true, "scope": "host codec-only; no RPC or mobile power measurement",
                                   "UTF8BOMPolicy": "preserved: Buffer.toString / TextDecoder(ignoreBOM:true); Node default TextDecoder strips BOM",
                                   "JSC_useJIT": ProcessInfo.processInfo.environment["JSC_useJIT"] ?? "unset"]
        weak var releasedContext: JSContext?
        weak var releasedVM: JSVirtualMachine?
        try autoreleasepool {
            guard let context = JSContext() else { throw CheckError.failed("Cannot create JSContext") }
            releasedContext = context
            releasedVM = context.virtualMachine
            TAHJavaScriptBytePrimitives.install(on: context)
            try require(context.exception == nil, "Install failed")
            _ = try evaluate(context, "const native = true;\n" + fixtures)
            _ = try evaluate(context, "const expected = " + oracle + ";" + #"""
            if (records.length !== expected.length) throw Error('Record count mismatch');
            for (let i = 0; i < expected.length; i++) {
                if (JSON.stringify(records[i]) !== JSON.stringify(expected[i]))
                    throw Error('Node mismatch at ' + expected[i][0] + ': ' +
                                JSON.stringify(records[i]).slice(0, 300) + ' != ' +
                                JSON.stringify(expected[i]).slice(0, 300));
            }
            """#)
            report["nodeOracleRecords"] = try evaluate(context, "records.length").toInt32()
            let checks = try evaluate(context, nativeChecks).toString() ?? "[]"
            report["nativeChecks"] = try JSONSerialization.jsonObject(with: Data(checks.utf8))
            if CommandLine.arguments.contains("--benchmark") {
                let measurements = try evaluate(context, benchmark).toString() ?? "{}"
                report["benchmark"] = try JSONSerialization.jsonObject(with: Data(measurements.utf8))
            }
            // Returned storage must own its bytes across GC and later allocations.
            _ = try evaluate(context, "globalThis.saved = __almaUTF8Encode('retained 中文 😀');")
            for _ in 0..<8 {
                _ = try evaluate(context, "for (let i=0;i<100;i++) __almaUTF8Encode('x'.repeat(8192));")
                JSGarbageCollect(context.jsGlobalContextRef)
            }
            try require(try evaluate(context, "__almaUTF8Decode(saved, true) === 'retained 中文 😀'").toBool(), "Returned storage lifetime")
        }
        try require(releasedContext == nil && releasedVM == nil, "Context/VM retained after autoreleasepool")
        report["contextAndVMReleased"] = true
        return String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self)
    }

    // The same fixture program runs in Node and JSC; native is its only switch.
    // Array.from/map loops below are test-only, never production byte marshaling.
    static let fixtures = #"""
    const records = [];
    const record = (name, result) => records.push([name, result]);
    const hex = a => Array.from(a, x => x.toString(16).padStart(2,'0')).join('');
    const raw = a => a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer,a.byteOffset,a.byteLength);
    const encode = native ? __almaUTF8Encode : s => Buffer.from(s, 'utf8');
    const byteLength = native ? __almaUTF8ByteLength : s => Buffer.byteLength(s, 'utf8');
    const decode = native ? __almaUTF8Decode : (a, fatal) => new TextDecoder('utf-8', {fatal,ignoreBOM:true}).decode(a);
    const b64 = native ? __almaBase64Encode : a => Buffer.from(raw(a)).toString('base64');
    const unb64 = native ? __almaBase64DecodeCanonical : s => {
        if (s.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return null;
        const b = Buffer.from(s, 'base64'); return b.toString('base64') === s ? b : null;
    };
    const sha = native ? __almaSHA256Bytes : a => require('node:crypto').createHash('sha256').update(raw(a)).digest('hex');
    if(!native) {
        const bom=new Uint8Array([239,187,191,65]);
        if(new TextDecoder().decode(bom)!=='A' || decode(bom,true)!=='\uFEFFA' ||
           Buffer.from(bom).toString('utf8')!=='\uFEFFA') throw Error('Unexpected Node BOM policy');
    }
    const strings = ['', 'ASCII\0\r\n', '中文测试', '😀🚀𝄞', '\uFFFD', '\uFEFFhi',
        '\ud800', '\udfff', 'a\ud800b', '\ud800\ud800', '\udc00\ud800', '\ud800\udc00',
        '\ud800\uFFFD\udc00', 'e\u0301é', String.fromCodePoint(0x10ffff)];
    for (let i=0;i<strings.length;i++) {
        const a=encode(strings[i]); record('encode-'+i,hex(a)); record('roundtrip-'+i,decode(a,true));
        record('byteLength-'+i,byteLength(strings[i]));
    }
    // Exhaust every UTF-16 code unit, plus deterministic surrogate pair sequences.
    let units=''; for (let i=0;i<65536;i++) units+=String.fromCharCode(i);
    record('all-utf16-units',sha(encode(units)));
    record('all-utf16-byteLength',byteLength(units));
    let seed=0x12345678;
    function next() { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed; }
    let surrogates=''; for(let i=0;i<10000;i++) surrogates+=String.fromCharCode(0xd800+(next()%2048));
    record('surrogate-sequences',sha(encode(surrogates)));
    record('surrogate-byteLength',byteLength(surrogates));
    const invalid = [[0xef,0xbf,0xbd],[0xef,0xbb,0xbf,65],[0xef,0xbb,0xbf,0xef,0xbb,0xbf],
        [0x80],[0xc0,0x80],[0xc1,0xbf],[0xc2],[0xc2,65],[0xe0,0x80,0x80],[0xe0,0xa0],
        [0xed,0xa0,0x80],[0xed,0xbf,0xbf],[0xe1,0x80,65],[0xf0,0x80,0x80,0x80],
        [0xf0,0x90,0x80],[0xf4,0x90,0x80,0x80],[0xf5,0x80,0x80,0x80],[0xff,0xfe],
        [0xf4,0x8f,0xbf,0xbf],[0xe2,0x82,0xac],[]];
    function decodeRecord(name, a) {
        record(name+'-replacement',decode(a,false));
        try { record(name+'-fatal',decode(a,true)); }
        catch(e) { record(name+'-fatal',{error:e.name,typeError:e instanceof TypeError}); }
        if (!native && decode(a,false)!==Buffer.from(a).toString('utf8')) throw Error('Node UTF8 oracle disagreement');
    }
    invalid.forEach((a,i)=>decodeRecord('utf8-'+i,Uint8Array.from(a)));
    // Exhaust all one/two-byte sequences; retain the exact decoded text, not a hash.
    let shortDecodes='', fatalFailures=0;
    for(let i=0;i<256;i++) for(let j=-1;j<256;j++) {
        const a=j<0 ? new Uint8Array([i]) : new Uint8Array([i,j]);
        shortDecodes+=decode(a,false)+'\0';
        try { decode(a,true); } catch(e) { if(!(e instanceof TypeError)) throw e; fatalFailures++; }
    }
    record('all-one-two-byte-decodes',shortDecodes); record('all-one-two-byte-fatal',fatalFailures);
    for (let i=0;i<256;i++) {
        const a=new Uint8Array(i); for(let j=0;j<i;j++) a[j]=next()>>>24;
        decodeRecord('random-'+i,a); record('b64-random-'+i,b64(a)); record('sha-random-'+i,sha(a));
        record('unb64-random-'+i,hex(unb64(b64(a))));
    }
    for (const s of ['', 'Zg==','Zm8=','Zm9v','AA==','AAA=','AAAA','/w==','//8=','////',
        'Zh==','Zm9=','AB==','AAB=','Zg','Zg=','Zg===','Zg====','Zg==\n',' Zg==',
        'Z g==','_w==','-w==','Zm9v=','====','A===','AA=A','Zg==AA==','éAAA','\ud800AAA','Zg==\0',
        '\u212AAA==','KA==','ＫＡ==']) {
        const a=unb64(s); record('canonical-'+JSON.stringify(s),a===null ? null : hex(a));
    }
    const backing=new Uint8Array([99,98,0x41,0xe4,0xb8,0xad,0xf0,0x9f,0x98,0x80,97,96]);
    const slice=backing.subarray(2,10);
    record('slice-utf8',decode(slice,true)); record('slice-b64',b64(slice)); record('slice-sha',sha(slice));
    const words=new Uint16Array(backing.buffer,2,4);
    record('uint16-raw-b64',b64(words)); record('uint16-raw-sha',sha(words));
    const types=[Int8Array,Uint8ClampedArray,Int16Array,Uint32Array,Int32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array];
    const typeBacking=new Uint8Array(32); for(let i=0;i<32;i++) typeBacking[i]=i*7;
    for(const T of types) {
        const view=new T(typeBacking.buffer,8,16/T.BYTES_PER_ELEMENT);
        record(T.name+'-offset-b64',b64(view)); record(T.name+'-offset-sha',sha(view));
    }
    record('arraybuffer-b64',b64(backing.buffer)); record('arraybuffer-sha',sha(backing.buffer));
    for (const a of [new Uint8Array(0),new ArrayBuffer(0),backing.subarray(12)]) {
        record('empty-b64',b64(a)); record('empty-sha',sha(a)); record('empty-decode',decode(a,true));
    }
    for (const size of [55,56,63,64,65,127,128,129,1000000]) {
        const a=new Uint8Array(size).fill(97); record('sha-a-'+size,sha(a));
    }
    """#

    static let nativeChecks = #"""
    (()=>{
        const checks=[];
        function ok(value,name) { if(!value) throw Error(name); checks.push(name); }
        function throwsType(f,name,Type=TypeError) {
            let caught=false; try { f(); } catch(e) { caught=e instanceof Type; }
            ok(caught,name);
        }
        for(const value of [null,undefined,[],{},'abc',42,new DataView(new ArrayBuffer(4)),new Proxy(new Uint8Array(4),{})]) {
            throwsType(()=>__almaBase64Encode(value),'reject non-byte input '+Object.prototype.toString.call(value));
        }
        throwsType(()=>__almaUTF8Encode({toString(){throw Error('coerced')}}),'no string coercion');
        throwsType(()=>__almaUTF8Decode(new Uint8Array(),0),'no boolean coercion');
        throwsType(()=>__almaSHA256Bytes(),'missing argument');
        const a=new Uint8Array([9,65,66,8]), slice=a.subarray(1,3);
        for(const key of ['byteOffset','byteLength','buffer']) Object.defineProperty(slice,key,{get(){throw Error('JS getter read')}});
        ok(__almaBase64Encode(slice)==='QUI=','C metadata ignores shadow getters');
        const descriptor=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength');
        try {
            Object.defineProperty(ArrayBuffer.prototype,'byteLength',{get(){throw Error('replaced getter')}});
            ok(__almaBase64Encode(slice)==='QUI=','captured intrinsic ignores later replacement');
        } finally { Object.defineProperty(ArrayBuffer.prototype,'byteLength',descriptor); }
        const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype), savedSet=typedArrayPrototype.set;
        try {
            typedArrayPrototype.set=function(){throw Error('replaced set')};
            ok(__almaBase64Encode(slice)==='QUI=' && __almaUTF8Encode('ab')[1]===98,'captured bulk-copy intrinsic');
        } finally { typedArrayPrototype.set=savedSet; }
        ok(__almaUTF8Encode('') instanceof Uint8Array,'empty result is Uint8Array');
        ok(__almaBase64DecodeCanonical('') instanceof Uint8Array,'empty base64 is Uint8Array');
        ok(__almaUTF8Decode(new Uint8Array([239,191,189]),true)==='\uFFFD','literal U+FFFD is valid fatal UTF8');
        ok(__almaUTF8Decode(new Uint8Array([239,187,191,65]),true)==='\uFEFFA','BOM preserved contract');
        // Standard transfer detaches both nonempty and already empty buffers.
        if(typeof ArrayBuffer.prototype.transfer==='function') {
            const readThenTransfer=new ArrayBuffer(4);
            __almaBase64Encode(readThenTransfer);
            ok(readThenTransfer.transfer().byteLength===4,'fixed buffer remains transferable after read');
            throwsType(()=>__almaBase64Encode(readThenTransfer),'read then detach remains rejected');
            for(const returned of [__almaUTF8Encode('abc'),__almaBase64DecodeCanonical('YWJj')]) {
                const original=returned.buffer, moved=original.transfer();
                ok(moved.byteLength===3 && original.byteLength===0,'returned buffer transfers and detaches normally');
            }
            for(const size of [0,4]) {
                const b=new ArrayBuffer(size), view=new Uint8Array(b); b.transfer();
                for(const input of [b,view]) {
                    throwsType(()=>__almaBase64Encode(input),'detached b64 size '+size);
                    throwsType(()=>__almaUTF8Decode(input,false),'detached decode size '+size);
                    throwsType(()=>__almaSHA256Bytes(input),'detached sha size '+size);
                }
            }
        } else throw Error('Detached test requires public ArrayBuffer.transfer support on this host');
        if(typeof ArrayBuffer.prototype.resize==='function') {
            const resizable=new ArrayBuffer(8,{maxByteLength:16});
            for(const input of [resizable,new Uint8Array(resizable)])
                throwsType(()=>__almaBase64Encode(input),'resizable storage rejected before pinning');
            resizable.resize(12);
            ok(resizable.transfer().byteLength===12,'rejected resizable buffer retains resize/transfer behavior');
        }
        if(typeof SharedArrayBuffer==='function') {
            for(const input of [new SharedArrayBuffer(4),new Uint8Array(new SharedArrayBuffer(4))])
                throwsType(()=>__almaBase64Encode(input),'shared storage rejected');
        } else checks.push('SharedArrayBuffer unavailable in this host VM');
        const limit=32*1024*1024;
        const large=new Uint8Array(limit+1);
        throwsType(()=>__almaSHA256Bytes(large),'oversized bytes',RangeError);
        throwsType(()=>__almaBase64Encode(large.buffer),'oversized ArrayBuffer',RangeError);
        ok(__almaBase64Encode(large.subarray(limit))==='AA==','small slice of large buffer');
        ok(__almaSHA256Bytes(large.subarray(0,limit)).length===64,'exact 32 MiB accepted');
        throwsType(()=>__almaUTF8Encode('x'.repeat(limit+1)),'oversized string',RangeError);
        throwsType(()=>__almaUTF8ByteLength('x'.repeat(limit+1)),'oversized byteLength input',RangeError);
        ok(__almaUTF8ByteLength('中'.repeat(Math.floor(limit/3)+1))>limit,'byteLength reports expanded length without byte allocation');
        throwsType(()=>__almaUTF8Encode('中'.repeat(Math.floor(limit/3)+1)),'UTF8 output expansion cap',RangeError);
        throwsType(()=>__almaBase64DecodeCanonical('A'.repeat(Math.ceil(limit/3)*4+4)),'base64 input cap',RangeError);
        throwsType(()=>__almaBase64DecodeCanonical('A'.repeat(Math.ceil(limit/3)*4)),'base64 decoded size cap',RangeError);
        const first=__almaUTF8Encode('abc'), second=__almaUTF8Encode('abc'); first[0]=0;
        ok(__almaUTF8Decode(second,true)==='abc','independent return storage');
        return JSON.stringify(checks);
    })()
    """#

    // Optional codec-only host microbenchmark. The JS comparator is a deliberately
    // simple base64 loop, NOT the production shim or an end-to-end RPC baseline.
    static let benchmark = #"""
    (()=>{
        const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        function jsBase64(a) {
            let s=''; for(let i=0;i<a.length;i+=3) {
                const n=(a[i]<<16)|((a[i+1]||0)<<8)|(a[i+2]||0);
                s+=alphabet[n>>>18]+alphabet[(n>>>12)&63]+(i+1<a.length?alphabet[(n>>>6)&63]:'=')+(i+2<a.length?alphabet[n&63]:'=');
            } return s;
        }
        const output=[]; let sink=0;
        for(const size of [64,4096,65536,1048576]) {
            const a=new Uint8Array(size); for(let i=0;i<size;i++) a[i]=i%251;
            const encoded=__almaBase64Encode(a), text='x'.repeat(size);
            if(jsBase64(a)!==encoded) throw Error('benchmark comparator');
            const iterations=size<=4096?200:size<=65536?30:5;
            const jobs={base64Native:()=>__almaBase64Encode(a),base64JSLoop:()=>jsBase64(a),
                base64DecodeNative:()=>__almaBase64DecodeCanonical(encoded),utf8EncodeNative:()=>__almaUTF8Encode(text),
                utf8ByteLengthNative:()=>({length:__almaUTF8ByteLength(text)}),
                utf8DecodeNative:()=>__almaUTF8Decode(a,false),sha256Native:()=>__almaSHA256Bytes(a)};
            const row={bytes:size,iterations,ms:{}};
            for(const [name,f] of Object.entries(jobs)) {
                for(let i=0;i<3;i++) sink+=f().length;
                const samples=[];
                for(let sample=0;sample<3;sample++) {
                    const start=Date.now(); for(let i=0;i<iterations;i++) sink+=f().length;
                    samples.push(Date.now()-start);
                }
                row.ms[name]=samples.sort((a,b)=>a-b)[1];
            }
            output.push(row);
        }
        return JSON.stringify({description:'host codec-only median of 3; ms per batch; no RPC or power inference',output,sink});
    })()
    """#
}

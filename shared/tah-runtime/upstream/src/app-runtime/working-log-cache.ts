/** Short, bounded read leases for an advertised live log. A UI can finish a
 * multi-chunk read while new events arrive; this is not execution/retry state. */
export class WorkingLogReadCache {
  readonly #entries = new Map<string, {bytes:Buffer; expires:number}>();
  constructor(private readonly now:()=>number=Date.now) {}
  pin(actionID:string, operationID:string, sha256:string, text:string):void {
    this.#expire();
    const key=this.#key(actionID,operationID,sha256);
    if(this.#entries.has(key))return;
    const bytes=Buffer.from(text);
    if(bytes.length>4*1024*1024)throw new Error("working log exceeds read bound");
    this.#entries.set(key,{bytes,expires:this.now()+30_000});
    while(this.#entries.size>4)this.#entries.delete(this.#entries.keys().next().value!);
  }
  get(actionID:string, operationID:string, sha256:string):Buffer|undefined {
    this.#expire();return this.#entries.get(this.#key(actionID,operationID,sha256))?.bytes;
  }
  clear():void {this.#entries.clear();}
  #key(actionID:string,operationID:string,sha256:string):string {return `${actionID}/${operationID}/${sha256}`;}
  #expire():void {for(const [key,value] of this.#entries)if(value.expires<=this.now())this.#entries.delete(key);}
}

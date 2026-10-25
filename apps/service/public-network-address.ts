import {BlockList,isIP} from 'node:net';

const denied=new BlockList();
for(const [address,prefix]of [
 ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
 ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],
 ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],
 ['224.0.0.0',4],['240.0.0.0',4],
] as const)denied.addSubnet(address,prefix,'ipv4');
export const publicNetworkAddress=(address:string)=>isIP(address)===4&&!denied.check(address,'ipv4');

/** A syntactic first boundary only. Network callers must also resolve, check
 * every returned address and pin the chosen numeric address for each hop. */
export function publicNetworkHostname(raw:string){
 const host=raw.toLowerCase().replace(/\.$/u,'');
 if(host.length>253||host.includes(':')||host.startsWith('['))return false;
 if(isIP(host))return publicNetworkAddress(host);
 return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(host)
  &&!['localhost','local','internal','home.arpa','test','invalid','onion'].some(suffix=>host===suffix||host.endsWith('.'+suffix));
}

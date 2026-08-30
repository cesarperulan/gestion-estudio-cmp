const base = process.env.SOS_BASE_URL || 'https://api.sos-contador.com';
const user = process.env.SOS_USER;
const password = process.env.SOS_PASSWORD;
const target = String(process.env.SOS_TARGET_CUIT || '20260964233').replace(/\D/g,'');
if(!user || !password){ console.error('Faltan SOS_USER / SOS_PASSWORD'); process.exit(2); }
const read = async (r,label)=>{ const t=await r.text(); if(!r.ok) throw new Error(`${label} ${r.status}: ${t.slice(0,800)}`); try{return JSON.parse(t)}catch{throw new Error(`${label}: respuesta no JSON: ${t.slice(0,800)}`)} };
const login = await read(await fetch(`${base}/api-comunidad/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({usuario:user,password})}),'login');
const jwt=login?.jwt||login?.token||login?.data?.jwt||login?.data?.token; const cuits=login?.cuits||login?.data?.cuits||[];
const norm=v=>String(v??'').replace(/\D/g,'');
const c=cuits.find(x=>[x?.cuit,x?.numeroCuit,x?.cuitNumero,x?.numero,x?.taxId,x?.identificacion].some(v=>norm(v)===target));
if(!c) throw new Error(`CUIT ${target} no encontrado. Disponibles: ${cuits.map(x=>norm(x?.cuit||x?.numeroCuit||x?.numero)).filter(Boolean).join(', ')}`);
const id=c?.id??c?._id??c?.cuitId;
const cred=await read(await fetch(`${base}/api-comunidad/cuit/credentials/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${jwt}`}}),'credenciales');
const token=cred?.jwt||cred?.token||cred?.data?.jwt||cred?.data?.token;
const payload=await read(await fetch(`${base}/api-comunidad/cliente/listado?proveedor=false&cliente=true&registros=200&pagina=1`,{headers:{Authorization:`Bearer ${token}`}}),'clientes');
const rows=Array.isArray(payload)?payload:(payload?.items||payload?.registros||payload?.clientes||payload?.data||payload?.resultados||payload?.content||[]);
console.log(JSON.stringify({ok:true,cuit:target,cuitId:id,clientes:rows.length,camposPrimerCliente:Object.keys(rows[0]||{}),primerCliente:rows[0]||null},null,2));

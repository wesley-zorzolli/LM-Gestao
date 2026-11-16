import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Dashboard from './Dashboard';
import './style.css';

function App(){
 const [email,setEmail]=useState<string|null>(null),[checking,setChecking]=useState(true),[login,setLogin]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{fetch('/api/me').then(r=>r.ok?r.json():null).then(x=>setEmail(x?.email||null)).catch(()=>{}).finally(()=>setChecking(false));},[]);
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:login,password})});const d=await r.json();if(!r.ok)throw Error(d.error||'Erro ao entrar');setEmail(d.email);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 if(checking)return <div className="login-screen">Carregando LM Gestão...</div>;
 if(!email)return <div className="login-screen"><form className="login-box" onSubmit={submit}><div className="login-mark">LM</div><h1>LM Gestão</h1><p>Acesso privado · Controle de custos automotivos</p><label>E-mail<input required type="email" value={login} onChange={e=>setLogin(e.target.value)} autoComplete="username"/></label><label>Senha<input required type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/></label>{error&&<div className="login-error">{error}</div>}<button type="submit" className="primary" disabled={busy}>{busy?'Entrando...':'Entrar no painel'}</button><small>Somente usuários cadastrados podem acessar.</small></form></div>;
 return <Dashboard email={email} signOut="/api/logout"/>;
}
createRoot(document.getElementById('root')!).render(<App/>);

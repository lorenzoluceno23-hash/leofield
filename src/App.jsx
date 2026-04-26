/* =============================================================
   LEOFIELD v1.1 — WORK IN PROGRESS, do NOT deploy as-is
   ============================================================= 

   STATO DEL FILE (lavoro interrotto a metà):
   
   ✅ FATTO:
   - Login screen con "Created by Lorenzo Luceno" + badge v1.1
   - Topbar mostra ★ FOUNDER / ◆ ADMIN basato su user.level
   - ZoomableLayoutModal riscritto per fullscreen vero con auto-fit 
     dinamico (calcola dimensioni viewport + immagine, riempie schermo)
   - NewSnagScreen: state assignedUserId al posto di assignedCompany
   - Step 5 del wizard ha <select> con optgroup Leonardo / Vendor
   - assignableUsers calcolato con permessi corretti (Leo=tutti, 
     vendor admin = solo se stesso)

   ⏳ DA FINIRE PER CHIUDERE v1.1:
   1. createSnag in MainApp deve salvare anche assigned_to (uuid utente)
      → riga ~295 dove c'è "assigned_company: data.assignedCompany,"
      manca "assigned_to: data.assignedUserId,"
   2. SnagScreen: mostrare il nome dell'utente assegnato 
      (cercare snag.assigned_to in users) oltre alla company
   3. UsersScreen: aggiungere bottoni "Promote to admin", "Demote 
      to member", "Delete account" rispettando i permessi:
         - founder può promuovere/demottare/cancellare CHIUNQUE tranne sé
         - admin Leonardo può promuovere/demottare member↔admin (no founder)
         - admin Leonardo può cancellare solo member (mai admin/founder)
         - admin vendor stessa cosa ma su altri vendor
         - chiamate via supabase.from('profiles').update({level:'admin'})
   4. ProjectsScreen / ProjectScreen: il FAB "+" per creare snag deve 
      apparire anche per vendor con level admin/founder
      (ora c'è solo `if (isLeo)` → cambiare in 
       `if (isLeo || (user.role==='vendor' && (user.level==='admin'||user.level==='founder')))`)
   5. Cambiare il FAB anche basato su: il vendor admin deve vedere 
      la lista users solo della sua company (non Leonardo)
   6. Verificare che sign-up assegni level='member' di default 
      (il trigger DB lo fa già — vedi migration_v1_1.sql)
   7. Test sintassi + zip finale

   ⚠️ PRE-REQUISITO PRIMA DEL DEPLOY:
   Eseguire `migration_v1_1.sql` sul Supabase del progetto.
   Lo script aggiunge: campo profiles.level, profiles.email_verified_at,
   campo snags.assigned_to, nuove RLS policies, trigger protect_founder,
   e promuove Lorenzo Luceno (lorenzo.luceno%@leonardo.com) a founder.

   FILE BASE: presente su GitHub leofield/main alla data 19 Apr 2026.
   Database Supabase: https://rptbuamczgoxjadenqrf.supabase.co
   Deploy live (vecchia versione 1.0): https://leofield.netlify.app
*/


import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import {
  Camera, ArrowLeft, Plus, Check, X, AlertCircle, Clock, CheckCircle2,
  Users, Settings, LogOut, MapPin, FileImage, ChevronRight, Building2,
  Trash2, Edit3, Shield, Briefcase, Upload, RotateCcw, Target, Download,
  Mail, KeyRound, UserPlus, Loader2, ZoomIn, ZoomOut, Maximize2, Move,
  Sparkles, UserCog, ListChecks, Bug
} from 'lucide-react';
import { supabase, dataUrlToBlob, getSignedUrl, MEDIA_BUCKET } from './supabase';
import { ASSET_LOGO, ASSET_LAYOUT_PRESET_BHX2, ASSET_FRAMES } from './assets';

/* =============================================================
   LEOFIELD — Leonardo Spa × Vendor field issue tracker
   Backed by Supabase: Auth + Postgres + Storage + Realtime
   ============================================================= */

// ---------- UTILITIES ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ============================================================
// VERSION & PATCH NOTES
// ============================================================
const APP_VERSION = '1.1.0';

const PATCH_NOTES = {
  version: APP_VERSION,
  title: "What's new in v1.1",
  subtitle: 'Release · April 2026',
  items: [
    {
      icon: 'Bug',
      title: 'Fixed: layout no longer cropped on mobile',
      detail: 'The full-screen modal now auto-fits the entire layout to your device, regardless of orientation. Previously the image stayed small even at 400% zoom — that bug is gone.',
    },
    {
      icon: 'Maximize2',
      title: 'True full-screen layout viewer',
      detail: 'Tap the points map or the layout in the snag wizard to open it edge-to-edge. Pinch to zoom up to 800%, drag to pan, tap to place a marker or open an existing one.',
    },
    {
      icon: 'UserCog',
      title: 'Three-tier permission system',
      detail: 'Users now have three levels: Founder, Admin and Member. Founder is untouchable. Admins (Leonardo or vendor) can promote, demote and remove members. Permissions show as ★ and ◆ badges next to names.',
    },
    {
      icon: 'UserPlus',
      title: 'Vendor admins can create snags',
      detail: 'A vendor promoted to admin can now open snags too — auto-assigned to themselves. Useful for self-reporting issues found during their own intervention.',
    },
    {
      icon: 'Users',
      title: 'Assign snags to a specific person',
      detail: 'When creating a snag, the "Assign to" dropdown now lists actual people (Leonardo + project vendors), grouped by company. The previous version only let you pick a company.',
    },
    {
      icon: 'ListChecks',
      title: 'Excel export — new column',
      detail: 'The exported file now includes both "Assigned company" and "Assigned user" so reports show who exactly is responsible.',
    },
  ],
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
         ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};
const fmtDateShort = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
};

function generatePointCode(user, projectSnagsByThisUser) {
  const count = projectSnagsByThisUser.length + 1;
  const surname = (user.last_name || '').replace(/\s+/g, '');
  const initial = (user.first_name || '?').charAt(0).toUpperCase();
  return `${surname}${initial}${count}`;
}

async function fileToCompressedDataUrl(file, maxDim = 1400, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const STATUS = {
  open:     { label: 'Open',    color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  ring: 'rgba(239,68,68,0.3)',  icon: AlertCircle },
  fixed:    { label: 'Pending', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', ring: 'rgba(245,158,11,0.3)', icon: Clock },
  approved: { label: 'Approved', color: '#10b981', bg: 'rgba(16,185,129,0.12)', ring: 'rgba(16,185,129,0.3)', icon: CheckCircle2 },
  rejected: { label: 'Rejected', color: '#9ca3af', bg: 'rgba(156,163,175,0.12)', ring: 'rgba(156,163,175,0.3)', icon: RotateCcw },
};

// =============================================================
// ROOT APP — handles auth state
// =============================================================
export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session || null);
      if (!data.session) setBooting(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) { setProfile(null); setBooting(false); }
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      // retry a few times in case trigger hasn't finished yet on sign-up
      for (let i = 0; i < 5; i++) {
        const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
        if (cancelled) return;
        if (data) { setProfile(data); setBooting(false); return; }
        await new Promise(r => setTimeout(r, 500));
      }
      setBooting(false);
    })();
    return () => { cancelled = true; };
  }, [session]);

  if (booting) return <><StyleTag /><BootScreen /></>;
  if (!session || !profile) return <AuthScreen />;
  return <MainApp me={profile} onLogout={() => supabase.auth.signOut()} />;
}

// =============================================================
// AUTH SCREEN — login + sign up
// =============================================================
function AuthScreen() {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');

  const isLeonardoEmail = /@leonardo\.com$/i.test(email.trim());

  const submit = async () => {
    setError(''); setInfo(''); setBusy(true);
    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      } else {
        if (!firstName.trim() || !lastName.trim()) throw new Error('First and last name required');
        if (!isLeonardoEmail && !company.trim()) throw new Error('Please specify your company name');
        const { error } = await supabase.auth.signUp({
          email: email.trim(), password,
          options: {
            data: {
              first_name: firstName.trim(),
              last_name: lastName.trim(),
              company: isLeonardoEmail ? 'Leonardo Spa' : company.trim(),
            },
          },
        });
        if (error) throw error;
        setInfo('Account created. Sign in now.');
        setMode('login');
        setPassword('');
      }
    } catch (e) {
      setError(e.message || 'Error');
    }
    setBusy(false);
  };

  return (
    <>
      <StyleTag />
      <div className="login-root">
        <CinematicSlideshow frames={ASSET_FRAMES} />
        <div className="login-overlay" />
        <div className="login-scanlines" />
        <div className="login-grain" />

        <span className="corner tl" /><span className="corner tr" />
        <span className="corner bl" /><span className="corner br" />

        <div className="login-top">
          <div className="login-logo-wrap">
            <img src={ASSET_LOGO} alt="Leonardo" className="login-logo" />
            <div className="login-logo-divider" />
            <div className="login-logo-tag">
              <strong>LEOFIELD</strong>
              Field Suite
            </div>
          </div>
          <div className="login-brand-meta">
            <span className="dot" />LIVE · V1.0
          </div>
        </div>

        <div className="login-content">
          <div className="login-hero">
            <h1 className="login-title">LEOFIELD</h1>
            <div className="login-descriptor">On Field &amp; Site Management</div>
            <div className="login-subtitle">Site Evolution</div>
            <p className="login-tagline">Building the future of logistics.</p>
            <div className="login-credit">
              <span>Created by</span> <strong>Lorenzo Luceno</strong>
              <span className="login-version">v1.1</span>
            </div>
          </div>

          <div className="login-form">
            {mode === 'signup' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First name" autoComplete="given-name" />
                <input value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last name" autoComplete="family-name" />
              </div>
            )}
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Work email" type="email" autoComplete="email" onKeyDown={e => e.key === 'Enter' && submit()} />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} onKeyDown={e => e.key === 'Enter' && submit()} />
            {mode === 'signup' && !isLeonardoEmail && email.includes('@') && (
              <input value={company} onChange={e => setCompany(e.target.value)} placeholder="Company name (e.g. i4 industry)" />
            )}
            {error && <div className="login-error">{error}</div>}
            {info && <div style={{ color: '#10b981', fontSize: 13 }}>{info}</div>}
            <button className="btn-login" onClick={submit} disabled={busy}>
              {busy ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }}/> : (mode === 'login' ? 'SIGN IN' : 'SIGN UP')}
            </button>
            <button
              onClick={() => { setError(''); setInfo(''); setMode(mode === 'login' ? 'signup' : 'login'); }}
              style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 4, cursor: 'pointer', padding: 8 }}
            >
              {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// =============================================================
// MAIN APP — logged-in state
// =============================================================
function MainApp({ me, onLogout }) {
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [snags, setSnags] = useState([]);
  const [navStack, setNavStack] = useState([{ screen: 'projects', params: {} }]);
  const [toast, setToast] = useState(null);
  const [showWhatsNew, setShowWhatsNew] = useState(false);

  // Show "What's new" modal at login if user hasn't seen the current version yet
  useEffect(() => {
    if (!me) return;
    try {
      const seen = localStorage.getItem('leofield_seen_version');
      if (seen !== APP_VERSION) {
        setShowWhatsNew(true);
      }
    } catch (e) {
      // localStorage might be blocked in some embedded contexts; show anyway
      setShowWhatsNew(true);
    }
  }, [me]);

  const dismissWhatsNew = () => {
    setShowWhatsNew(false);
    try { localStorage.setItem('leofield_seen_version', APP_VERSION); } catch {}
  };

  const showToast = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind, id: Date.now() });
    setTimeout(() => setToast(null), 2500);
  }, []);

  const loadUsers = useCallback(async () => {
    const { data, error } = await supabase.from('profiles').select('*').order('last_name');
    if (!error && data) setUsers(data);
  }, []);

  const loadProjects = useCallback(async () => {
    const { data, error } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
    if (!error && data) setProjects(data);
  }, []);

  const loadSnags = useCallback(async () => {
    const { data, error } = await supabase.from('snags').select('*').order('created_at', { ascending: false });
    if (!error && data) setSnags(data);
  }, []);

  useEffect(() => {
    loadUsers(); loadProjects(); loadSnags();
  }, [loadUsers, loadProjects, loadSnags]);

  // Realtime
  useEffect(() => {
    const channel = supabase
      .channel('leofield-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'snags' }, () => loadSnags())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => loadProjects())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadUsers())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadSnags, loadProjects, loadUsers]);

  const currentScreen = navStack[navStack.length - 1];
  const push = (screen, params = {}) => setNavStack(s => [...s, { screen, params }]);
  const pop = () => setNavStack(s => s.length > 1 ? s.slice(0, -1) : s);
  const reset = (screen = 'projects', params = {}) => setNavStack([{ screen, params }]);

  // ---------- ACTIONS ----------
  async function createSnag(data) {
    try {
      // Upload primary photo
      const photoBlob = dataUrlToBlob(data.photo);
      const photoPath = `photos/${uid()}.jpg`;
      const { error: upErr } = await supabase.storage.from(MEDIA_BUCKET).upload(photoPath, photoBlob, { contentType: 'image/jpeg' });
      if (upErr) throw upErr;

      const { error } = await supabase.from('snags').insert({
        code: data.code,
        project_id: data.projectId,
        title: data.title,
        description: data.description,
        photo_path: photoPath,
        photo_mark: data.photoMark,
        mark: data.mark,
        status: 'open',
        created_by: me.id,
        assigned_company: data.assignedCompany,
        assigned_to: data.assignedUserId || null,
        history: [{ at: new Date().toISOString(), by: me.id, action: 'created' }],
      });
      if (error) throw error;
      showToast(`Snag ${data.code} created`, 'success');
      await loadSnags();
      reset('project'); push('project', { projectId: data.projectId });
    } catch (e) {
      showToast('Error: ' + (e.message || e), 'error');
      console.error(e);
    }
  }

  async function resolveSnag(snag, resolutionPhotoDataUrl, note) {
    try {
      const blob = dataUrlToBlob(resolutionPhotoDataUrl);
      const path = `resolutions/${uid()}.jpg`;
      const { error: upErr } = await supabase.storage.from(MEDIA_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
      if (upErr) throw upErr;
      const updated = {
        status: 'fixed',
        resolution: { photo_path: path, note: note || '', by: me.id, at: new Date().toISOString() },
        history: [...(snag.history || []), { at: new Date().toISOString(), by: me.id, action: 'resolved' }],
      };
      const { error } = await supabase.from('snags').update(updated).eq('id', snag.id);
      if (error) throw error;
      showToast('Resolution submitted', 'success');
      await loadSnags();
    } catch (e) {
      showToast('Error: ' + (e.message || e), 'error');
      console.error(e);
    }
  }

  async function approveSnag(snag) {
    const updated = {
      status: 'approved',
      approval: { by: me.id, at: new Date().toISOString() },
      history: [...(snag.history || []), { at: new Date().toISOString(), by: me.id, action: 'approved' }],
    };
    const { error } = await supabase.from('snags').update(updated).eq('id', snag.id);
    if (error) { showToast('Error: ' + error.message, 'error'); return; }
    showToast('Approved', 'success');
    await loadSnags();
  }

  async function rejectSnag(snag, note) {
    const updated = {
      status: 'open',
      resolution: null, approval: null,
      history: [...(snag.history || []), { at: new Date().toISOString(), by: me.id, action: 'rejected', note: note || '' }],
    };
    const { error } = await supabase.from('snags').update(updated).eq('id', snag.id);
    if (error) { showToast('Error: ' + error.message, 'error'); return; }
    showToast('Snag reopened', 'info');
    await loadSnags();
  }

  async function deleteSnag(id) {
    const { error } = await supabase.from('snags').delete().eq('id', id);
    if (error) { showToast('Error: ' + error.message, 'error'); return; }
    showToast('Snag deleted', 'info');
    await loadSnags();
    pop();
  }

  async function createProject(data) {
    try {
      let layoutPath = null;
      if (data.layoutImage) {
        const blob = dataUrlToBlob(data.layoutImage);
        layoutPath = `layouts/${uid()}.jpg`;
        const { error: upErr } = await supabase.storage.from(MEDIA_BUCKET).upload(layoutPath, blob, { contentType: 'image/jpeg' });
        if (upErr) throw upErr;
      }
      const { error } = await supabase.from('projects').insert({
        name: data.name, description: data.description,
        layout_image_path: layoutPath, vendors: data.vendors,
        created_by: me.id,
      });
      if (error) throw error;
      showToast('Project created', 'success');
      await loadProjects();
      pop();
    } catch (e) {
      showToast('Error: ' + (e.message || e), 'error');
      console.error(e);
    }
  }

  async function updateProject(project, newData) {
    try {
      let layoutPath = project.layout_image_path;
      if (newData.layoutImage && newData.layoutImage !== project.layout_image_path) {
        // new base64 means new upload
        if (newData.layoutImage.startsWith('data:')) {
          const blob = dataUrlToBlob(newData.layoutImage);
          layoutPath = `layouts/${uid()}.jpg`;
          const { error: upErr } = await supabase.storage.from(MEDIA_BUCKET).upload(layoutPath, blob, { contentType: 'image/jpeg' });
          if (upErr) throw upErr;
        }
      } else if (newData.layoutImage === null) {
        layoutPath = null;
      }
      const { error } = await supabase.from('projects').update({
        name: newData.name, description: newData.description,
        layout_image_path: layoutPath, vendors: newData.vendors,
      }).eq('id', project.id);
      if (error) throw error;
      showToast('Project updated', 'success');
      await loadProjects();
    } catch (e) {
      showToast('Error: ' + (e.message || e), 'error');
    }
  }

  async function deleteProject(id) {
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (error) { showToast('Error: ' + error.message, 'error'); return; }
    showToast('Project deleted', 'info');
    await loadProjects(); await loadSnags();
    reset('projects');
  }

  async function setUserLevel(userId, newLevel) {
    const { error } = await supabase.from('profiles').update({ level: newLevel }).eq('id', userId);
    if (error) { showToast('Error: ' + error.message, 'error'); return; }
    showToast(newLevel === 'admin' ? 'User promoted to admin' : 'User demoted to member', 'success');
    await loadUsers();
  }

  async function deleteUser(userId) {
    // Note: this removes the profile row. The auth.users entry remains but will be
    // recreated on next sign-in via the handle_new_user trigger. For full deletion
    // an admin must remove the user from Supabase Auth panel as well.
    const { error } = await supabase.from('profiles').delete().eq('id', userId);
    if (error) { showToast('Error: ' + error.message, 'error'); return; }
    showToast('Account removed', 'info');
    await loadUsers();
  }

  return (
    <>
      <StyleTag />
      <div className="sl-root">
        <TopBar
          screen={currentScreen.screen} params={currentScreen.params}
          user={me} canGoBack={navStack.length > 1}
          onBack={pop} onLogout={onLogout}
          projects={projects} snags={snags}
        />
        <main className="sl-main">
          {currentScreen.screen === 'projects' && (
            <ProjectsScreen
              user={me} projects={projects} snags={snags}
              onOpen={(p) => push('project', { projectId: p.id })}
              onNewProject={() => push('newProject')}
              onUsers={() => push('users')}
            />
          )}
          {currentScreen.screen === 'project' && (
            <ProjectScreen
              user={me}
              project={projects.find(p => p.id === currentScreen.params.projectId)}
              allSnags={snags} users={users}
              onOpenSnag={(snagId) => push('snag', { snagId })}
              onNewSnag={() => push('newSnag', { projectId: currentScreen.params.projectId })}
              onSettings={() => push('projectSettings', { projectId: currentScreen.params.projectId })}
              onShowToast={showToast}
            />
          )}
          {currentScreen.screen === 'newSnag' && (
            <NewSnagScreen
              user={me}
              project={projects.find(p => p.id === currentScreen.params.projectId)}
              allSnags={snags} users={users}
              onCancel={pop}
              onCreate={createSnag}
            />
          )}
          {currentScreen.screen === 'snag' && (
            <SnagScreen
              user={me} users={users} projects={projects}
              snag={snags.find(s => s.id === currentScreen.params.snagId)}
              onBack={pop}
              onResolve={resolveSnag}
              onApprove={approveSnag}
              onReject={rejectSnag}
              onDelete={deleteSnag}
            />
          )}
          {currentScreen.screen === 'newProject' && (
            <NewProjectScreen
              user={me} users={users}
              onCancel={pop}
              onCreate={createProject}
            />
          )}
          {currentScreen.screen === 'projectSettings' && (
            <ProjectSettingsScreen
              user={me} users={users}
              project={projects.find(p => p.id === currentScreen.params.projectId)}
              onBack={pop}
              onUpdate={updateProject}
              onDelete={deleteProject}
            />
          )}
          {currentScreen.screen === 'users' && (
            <UsersScreen
              user={me} users={users}
              onBack={pop} onShowToast={showToast}
              onSetLevel={setUserLevel}
              onDeleteUser={deleteUser}
            />
          )}
        </main>
        {toast && <Toast msg={toast.msg} kind={toast.kind} />}
        {showWhatsNew && <WhatsNewModal onClose={dismissWhatsNew} />}
      </div>
    </>
  );
}

// =============================================================
// Hook: sign URL for a storage path
// =============================================================
function useSignedUrl(path) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!path) { setUrl(null); return; }
    getSignedUrl(path).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [path]);
  return url;
}

// =============================================================
// COMPONENTS
// =============================================================

function BootScreen() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: '#9ba1ab', fontFamily: 'IBM Plex Mono, monospace', fontSize: 13 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ letterSpacing: '0.4em', color: '#e30613', fontSize: 11, marginBottom: 8, fontWeight: 600 }}>LEOFIELD</div>
        <div>loading…</div>
      </div>
    </div>
  );
}

function CinematicSlideshow({ frames, intervalMs = 4200 }) {
  const [current, setCurrent] = useState(0);
  const [previous, setPrevious] = useState(frames.length - 1);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setPrevious(current);
      setCurrent(c => (c + 1) % frames.length);
      setPulsing(true);
      setTimeout(() => setPulsing(false), 900);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [current, intervalMs, frames.length]);

  return (
    <div className="slideshow">
      <img src={frames[previous]} className="slide slide-prev" key={`prev-${previous}-${current}`} alt="" />
      <img src={frames[current]} className="slide slide-curr" key={`curr-${current}`} alt="" />
      <div className={`slide-pulse ${pulsing ? 'active' : ''}`} />
    </div>
  );
}

function TopBar({ screen, params, user, canGoBack, onBack, onLogout, projects, snags }) {
  const title = useMemo(() => {
    if (screen === 'projects') return 'Projects';
    if (screen === 'project') { const p = projects.find(x => x.id === params.projectId); return p?.name || 'Project'; }
    if (screen === 'newSnag') return 'New Snag';
    if (screen === 'snag') { const s = snags.find(x => x.id === params.snagId); return s ? s.code : 'Snag'; }
    if (screen === 'newProject') return 'New Project';
    if (screen === 'projectSettings') return 'Settings';
    if (screen === 'users') return 'Users';
    return 'LEOFIELD';
  }, [screen, params, projects, snags]);

  return (
    <div className="topbar">
      {canGoBack ? (
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ArrowLeft size={20} /></button>
      ) : (
        <img src={ASSET_LOGO} alt="Leonardo" style={{ height: 18, width: 'auto' }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 9, letterSpacing: '0.25em', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 600 }}>LEOFIELD</div>
        <div style={{ fontWeight: 600, fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{user.first_name}</div>
        <div style={{ fontSize: 9, color: user.role === 'leonardo' ? 'var(--accent)' : 'var(--text-faint)', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          {user.level === 'founder' && '★ '}
          {user.level === 'admin' && '◆ '}
          {user.role === 'leonardo' ? 'Leonardo' : user.company}
        </div>
      </div>
      <button className="icon-btn" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={18} /></button>
    </div>
  );
}

function ProjectsScreen({ user, projects, snags, onOpen, onNewProject, onUsers }) {
  const isLeo = user.role === 'leonardo';
  const isVendorAdmin = user.role === 'vendor' && (user.level === 'admin' || user.level === 'founder');
  // server-side RLS already filters, but double-check
  const visible = isLeo ? projects : projects.filter(p => (p.vendors || []).includes(user.company));

  return (
    <div style={{ paddingTop: 20 }}>
      {isLeo ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <button className="btn btn-ghost" onClick={onUsers} style={{ flex: 1 }}>
            <Users size={16} /> Users
          </button>
          <button className="btn btn-primary" onClick={onNewProject} style={{ flex: 1 }}>
            <Plus size={16} /> Project
          </button>
        </div>
      ) : isVendorAdmin ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <button className="btn btn-ghost" onClick={onUsers} style={{ flex: 1 }}>
            <Users size={16} /> Users
          </button>
        </div>
      ) : null}

      <div style={{ fontSize: 11, letterSpacing: '0.15em', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 12, fontWeight: 600 }}>
        {visible.length} {visible.length === 1 ? 'project' : 'projects'}
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          <Briefcase size={32} style={{ opacity: 0.4, marginBottom: 8 }} />
          <div>No projects available.</div>
          {isLeo && <div style={{ fontSize: 13, marginTop: 4 }}>Create your first project to get started.</div>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visible.map(p => {
            const ps = snags.filter(s => s.project_id === p.id);
            const open = ps.filter(s => s.status === 'open').length;
            const fixed = ps.filter(s => s.status === 'fixed').length;
            return (
              <button key={p.id} onClick={() => onOpen(p)} className="card card-hover fadeIn" style={{ textAlign: 'left', color: 'inherit' }}>
                <div className="card-row" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 44, height: 44, background: 'var(--accent-soft)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', flexShrink: 0 }}>
                    <Briefcase size={20} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 16 }}>{p.name}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.description || 'No description'}
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 8, fontSize: 12 }}>
                      {open > 0 && <span style={{ color: '#ef4444' }}>● {open} open</span>}
                      {fixed > 0 && <span style={{ color: '#f59e0b' }}>● {fixed} pending</span>}
                      {open === 0 && fixed === 0 && <span style={{ color: 'var(--text-faint)' }}>No snags</span>}
                    </div>
                  </div>
                  <ChevronRight size={20} color="var(--text-faint)" />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectScreen({ user, project, allSnags, users, onOpenSnag, onNewSnag, onSettings, onShowToast }) {
  const [filter, setFilter] = useState('all');
  const isLeo = user.role === 'leonardo';
  const layoutUrl = useSignedUrl(project?.layout_image_path);

  if (!project) return <div className="empty" style={{ marginTop: 24 }}>Project not found.</div>;

  const projectSnags = allSnags.filter(s => s.project_id === project.id);
  const visible = isLeo ? projectSnags : projectSnags.filter(s => s.assigned_company === user.company);
  const counts = {
    all: visible.length,
    open: visible.filter(s => s.status === 'open').length,
    fixed: visible.filter(s => s.status === 'fixed').length,
    approved: visible.filter(s => s.status === 'approved').length,
  };
  const filtered = filter === 'all' ? visible : visible.filter(s => s.status === filter);
  const openOnes = visible.filter(s => s.status === 'open');

  const exportExcel = () => {
    try {
      const rows = visible.map(s => {
        const creator = users.find(u => u.id === s.created_by);
        const resolver = users.find(u => u.id === s.resolution?.by);
        const approver = users.find(u => u.id === s.approval?.by);
        const assignee = users.find(u => u.id === s.assigned_to);
        return {
          'Code': s.code, 'Status': STATUS[s.status]?.label || s.status,
          'Title': s.title, 'Description': s.description || '',
          'Created by': creator ? `${creator.first_name} ${creator.last_name}` : '',
          'Creator company': creator?.company || '',
          'Created at': s.created_at ? new Date(s.created_at).toLocaleString('en-GB') : '',
          'Assigned company': s.assigned_company || '',
          'Assigned user': assignee ? `${assignee.first_name} ${assignee.last_name}` : '',
          'Resolved by': resolver ? `${resolver.first_name} ${resolver.last_name}` : '',
          'Resolved at': s.resolution?.at ? new Date(s.resolution.at).toLocaleString('en-GB') : '',
          'Resolution notes': s.resolution?.note || '',
          'Approved by': approver ? `${approver.first_name} ${approver.last_name}` : '',
          'Approved at': s.approval?.at ? new Date(s.approval.at).toLocaleString('en-GB') : '',
          'Layout X (%)': s.mark ? (s.mark.x * 100).toFixed(1) : '',
          'Layout Y (%)': s.mark ? (s.mark.y * 100).toFixed(1) : '',
        };
      });
      if (rows.length === 0) { onShowToast('No data to export', 'info'); return; }
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 30 }, { wch: 40 }, { wch: 20 }, { wch: 18 }, { wch: 20 }, { wch: 18 }, { wch: 22 }, { wch: 20 }, { wch: 20 }, { wch: 30 }, { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 15 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Snag List');
      XLSX.writeFile(wb, `LEOFIELD_${project.name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.xlsx`);
      onShowToast(`Exported ${rows.length} snags`, 'success');
    } catch (e) { onShowToast('Export error', 'error'); }
  };

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, letterSpacing: '0.15em', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 600 }}>Project</div>
          <div style={{ fontWeight: 700, fontSize: 22, letterSpacing: '-0.01em' }}>{project.name}</div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="icon-btn" onClick={exportExcel} title="Export Excel"><Download size={18}/></button>
          {isLeo && <button className="icon-btn" onClick={onSettings}><Settings size={18}/></button>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        <div className="stat-card"><div className="stat-num" style={{ color: '#ef4444' }}>{counts.open}</div><div className="stat-lbl">Open</div></div>
        <div className="stat-card"><div className="stat-num" style={{ color: '#f59e0b' }}>{counts.fixed}</div><div className="stat-lbl">Pending</div></div>
        <div className="stat-card"><div className="stat-num" style={{ color: '#10b981' }}>{counts.approved}</div><div className="stat-lbl">Approved</div></div>
      </div>

      {openOnes.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: '0.15em', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>
            <Target size={11} style={{ verticalAlign: 'middle', marginRight: 4 }}/>Open points · {openOnes.length}
          </div>
          <div className="codes-row">
            {openOnes.map(s => (
              <button key={s.id} className="code-chip" onClick={() => onOpenSnag(s.id)}>
                <span className="dot"/>{s.code}
              </button>
            ))}
          </div>
        </div>
      )}

      {layoutUrl && visible.some(s => s.mark) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: '0.15em', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>
            <MapPin size={11} style={{ verticalAlign: 'middle', marginRight: 4 }}/>Point map
          </div>
          <LayoutWithAllMarkers image={layoutUrl} snags={visible.filter(s => s.mark)} onOpenSnag={onOpenSnag}/>
        </div>
      )}

      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {['all', 'open', 'fixed', 'approved'].map(k => (
          <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
            {k === 'all' ? 'All' : STATUS[k]?.label} <span className="mono" style={{ opacity: 0.6 }}>{counts[k]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <AlertCircle size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
          <div>No snags {filter !== 'all' ? STATUS[filter]?.label.toLowerCase() : ''}.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(s => <SnagCard key={s.id} snag={s} users={users} onClick={() => onOpenSnag(s.id)} />)}
        </div>
      )}

      {(isLeo || (user.role === 'vendor' && (user.level === 'admin' || user.level === 'founder'))) && (
        <div className="fab">
          <button onClick={onNewSnag} aria-label="New snag"><Plus size={24}/></button>
        </div>
      )}
    </div>
  );
}

function LayoutWithAllMarkers({ image, snags, onOpenSnag }) {
  const [modalOpen, setModalOpen] = useState(false);
  const colorFor = (s) => STATUS[s.status]?.color || '#ef4444';
  const markers = snags.map(s => ({ id: s.id, mark: s.mark, color: colorFor(s), code: s.code, status: s.status }));
  return (
    <>
      <div className="layout-canvas interactive" onClick={() => setModalOpen(true)}>
        <img src={image} alt="layout" />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ pointerEvents: 'none' }}>
          {snags.map(s => (
            <g key={s.id}>
              <circle cx={s.mark.x * 100} cy={s.mark.y * 100} r={2.2} fill="none" stroke={colorFor(s)} strokeWidth="0.7" vectorEffect="non-scaling-stroke" className={s.status === 'open' ? 'marker-pulse' : ''}/>
              <circle cx={s.mark.x * 100} cy={s.mark.y * 100} r={0.7} fill={colorFor(s)} />
            </g>
          ))}
        </svg>
        <div className="layout-tap-hint">
          <Maximize2 size={14}/> Tap to zoom &amp; explore
        </div>
      </div>
      {modalOpen && (
        <ZoomableLayoutModal
          imageUrl={image}
          markers={markers}
          onMarkerClick={(id) => onOpenSnag(id)}
          onClose={() => setModalOpen(false)}
          title="Points map"
        />
      )}
    </>
  );
}

function SnagCard({ snag, users, onClick }) {
  const st = STATUS[snag.status] || STATUS.open;
  const creator = users.find(u => u.id === snag.created_by);
  const StIcon = st.icon;
  const photoUrl = useSignedUrl(snag.photo_path);
  return (
    <button onClick={onClick} className="card card-hover fadeIn" style={{ textAlign: 'left', color: 'inherit' }}>
      <div style={{ display: 'flex', gap: 12, padding: 12 }}>
        <div style={{ width: 72, height: 72, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-2)', border: '1px solid var(--border)', position: 'relative' }}>
          {photoUrl ? <img src={photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ width: '100%', height: '100%', display:'flex', alignItems:'center', justifyContent:'center', color: 'var(--text-faint)'}}><FileImage size={24}/></div>}
          {snag.photo_mark && photoUrl && (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
              <PhotoCrossMark x={snag.photo_mark.x} y={snag.photo_mark.y} size={6} />
            </svg>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
            <div className="mono" style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{snag.code}</div>
            <span className="badge" style={{ background: st.bg, color: st.color, border: `1px solid ${st.ring}` }}>
              <StIcon size={12}/> {st.label}
            </span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{snag.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {creator ? `${creator.first_name} ${creator.last_name}` : '—'} · {fmtDateShort(snag.created_at)}
          </div>
        </div>
      </div>
    </button>
  );
}

function PhotoCrossMark({ x, y, size = 8, stroke = 3, color = '#ef4444' }) {
  const cx = x * 100, cy = y * 100;
  const s = size / 2;
  return (
    <g>
      <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} stroke="white" strokeWidth={stroke + 1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      <line x1={cx - s} y1={cy + s} x2={cx + s} y2={cy - s} stroke="white" strokeWidth={stroke + 1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} stroke={color} strokeWidth={stroke} strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      <line x1={cx - s} y1={cy + s} x2={cx + s} y2={cy - s} stroke={color} strokeWidth={stroke} strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      <circle cx={cx} cy={cy} r={size * 0.9} fill="none" stroke="white" strokeWidth="1" opacity="0.8" vectorEffect="non-scaling-stroke"/>
      <circle cx={cx} cy={cy} r={size * 0.9} fill="none" stroke={color} strokeWidth="0.6" vectorEffect="non-scaling-stroke"/>
    </g>
  );
}

function PhotoMarkup({ image, mark, onChange, readOnly = false }) {
  const ref = useRef(null);
  const setFromEvent = (e) => {
    if (readOnly || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    onChange({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
  };
  return (
    <div ref={ref} className={`markup-canvas ${readOnly ? '' : 'interactive'}`}
         onClick={setFromEvent}
         onTouchStart={(e) => { e.preventDefault(); setFromEvent(e); }}>
      <img src={image} alt="" />
      {mark && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <PhotoCrossMark x={mark.x} y={mark.y} size={8} stroke={2.5}/>
        </svg>
      )}
    </div>
  );
}

// =============================================================
// ZOOMABLE LAYOUT MODAL — fullscreen pinch-to-zoom + pan + tap
// Works for both placement mode (onMarkChange) and view mode (onMarkerClick)
// =============================================================
function ZoomableLayoutModal({
  imageUrl,
  markers = [],
  initialMark = null,
  onMarkChange = null,
  onMarkerClick = null,
  onClose,
  title = 'Layout',
}) {
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const [draft, setDraft] = useState(initialMark);
  const [imgSize, setImgSize] = useState(null); // { w, h } natural image size
  const [vpSize, setVpSize] = useState(null);   // { w, h } viewport box size
  const [fitScale, setFitScale] = useState(1);  // base scale to fit viewport
  const viewportRef = useRef(null);
  const imgRef = useRef(null);
  const pointers = useRef(new Map());
  const lastPinch = useRef(null);
  const tapTracker = useRef(null);

  const isPlacing = onMarkChange !== null;

  // Clamp scale relative to fit
  const MIN_SCALE = 0.6;  // a bit below initial fit
  const MAX_SCALE = 8;    // 8x zoom in
  const clampScale = (s) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

  // Measure viewport on mount + on resize
  useEffect(() => {
    const measure = () => {
      if (!viewportRef.current) return;
      const r = viewportRef.current.getBoundingClientRect();
      setVpSize({ w: r.width, h: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  // When image and viewport are both known, compute fit scale and center
  useEffect(() => {
    if (!imgSize || !vpSize) return;
    const ratio = Math.min(vpSize.w / imgSize.w, vpSize.h / imgSize.h);
    const baseScale = ratio * 0.95; // small padding so it doesn't touch edges
    const scaledW = imgSize.w * baseScale;
    const scaledH = imgSize.h * baseScale;
    setFitScale(baseScale);
    setView({
      scale: 1,
      tx: (vpSize.w - scaledW) / 2,
      ty: (vpSize.h - scaledH) / 2,
    });
  }, [imgSize, vpSize]);

  const onImgLoad = (e) => {
    const img = e.currentTarget;
    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
  };

  const onPointerDown = (e) => {
    viewportRef.current?.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 1) {
      tapTracker.current = {
        id: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        moved: false, t: Date.now(),
      };
    } else if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      lastPinch.current = {
        dist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
        cx: (p1.x + p2.x) / 2,
        cy: (p1.y + p2.y) / 2,
      };
      tapTracker.current = null;
    }
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && lastPinch.current) {
      const [p1, p2] = [...pointers.current.values()];
      const newDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const newCx = (p1.x + p2.x) / 2;
      const newCy = (p1.y + p2.y) / 2;
      const ratio = newDist / lastPinch.current.dist;
      const panDx = newCx - lastPinch.current.cx;
      const panDy = newCy - lastPinch.current.cy;

      setView(v => {
        const newScale = clampScale(v.scale * ratio);
        const actualRatio = newScale / v.scale;
        return {
          scale: newScale,
          tx: newCx - (newCx - v.tx) * actualRatio + panDx,
          ty: newCy - (newCy - v.ty) * actualRatio + panDy,
        };
      });
      lastPinch.current = { dist: newDist, cx: newCx, cy: newCy };
    } else if (pointers.current.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      setView(v => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
      if (tapTracker.current && tapTracker.current.id === e.pointerId) {
        const totDx = e.clientX - tapTracker.current.startX;
        const totDy = e.clientY - tapTracker.current.startY;
        if (Math.hypot(totDx, totDy) > 6) tapTracker.current.moved = true;
      }
    }
  };

  const handleTap = (clientX, clientY) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;

    if (isPlacing) {
      setDraft({ x, y });
    } else if (onMarkerClick && markers.length) {
      let closest = null, closestDist = Infinity;
      for (const m of markers) {
        const mx = rect.left + m.mark.x * rect.width;
        const my = rect.top + m.mark.y * rect.height;
        const d = Math.hypot(mx - clientX, my - clientY);
        if (d < closestDist) { closestDist = d; closest = m; }
      }
      if (closest && closestDist < 44) {
        onMarkerClick(closest.id);
        onClose();
      }
    }
  };

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) lastPinch.current = null;

    if (tapTracker.current && tapTracker.current.id === e.pointerId) {
      const elapsed = Date.now() - tapTracker.current.t;
      if (!tapTracker.current.moved && elapsed < 400) {
        handleTap(e.clientX, e.clientY);
      }
      tapTracker.current = null;
    }
  };

  const reset = () => {
    if (!imgSize || !vpSize) { setView({ scale: 1, tx: 0, ty: 0 }); return; }
    const scaledW = imgSize.w * fitScale;
    const scaledH = imgSize.h * fitScale;
    setView({
      scale: 1,
      tx: (vpSize.w - scaledW) / 2,
      ty: (vpSize.h - scaledH) / 2,
    });
  };
  const zoomIn = () => setView(v => {
    const newScale = clampScale(v.scale * 1.4);
    const actualRatio = newScale / v.scale;
    const vp = viewportRef.current?.getBoundingClientRect();
    if (!vp) return { ...v, scale: newScale };
    const cx = vp.width / 2, cy = vp.height / 2;
    return { scale: newScale, tx: cx - (cx - v.tx) * actualRatio, ty: cy - (cy - v.ty) * actualRatio };
  });
  const zoomOut = () => setView(v => {
    const newScale = clampScale(v.scale / 1.4);
    const actualRatio = newScale / v.scale;
    const vp = viewportRef.current?.getBoundingClientRect();
    if (!vp) return { ...v, scale: newScale };
    const cx = vp.width / 2, cy = vp.height / 2;
    return { scale: newScale, tx: cx - (cx - v.tx) * actualRatio, ty: cy - (cy - v.ty) * actualRatio };
  });

  const confirm = () => {
    if (draft && onMarkChange) onMarkChange(draft);
    onClose();
  };

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Final transform: combine fit scale + user view scale
  const totalScale = fitScale * view.scale;
  const displayPct = Math.round(view.scale * 100);

  return (
    <div className="zoom-modal-backdrop">
      <div className="zoom-header">
        <button className="zoom-icon-btn" onClick={onClose} aria-label="Close"><X size={20}/></button>
        <div className="zoom-title">{title}</div>
        <div className="zoom-controls">
          <button className="zoom-icon-btn" onClick={zoomOut} aria-label="Zoom out"><ZoomOut size={18}/></button>
          <button className="zoom-pct" onClick={reset}>{displayPct}%</button>
          <button className="zoom-icon-btn" onClick={zoomIn} aria-label="Zoom in"><ZoomIn size={18}/></button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="zoom-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {imgSize && vpSize ? (
          <div
            className="zoom-canvas"
            style={{
              width: imgSize.w,
              height: imgSize.h,
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${totalScale})`,
              transformOrigin: '0 0',
            }}
          >
            <img ref={imgRef} src={imageUrl} alt="" draggable={false} />
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="zoom-markers-svg">
              {markers.map(m => (
                <g key={m.id}>
                  <circle cx={m.mark.x * 100} cy={m.mark.y * 100} r={2.5} fill="none" stroke={m.color || '#ef4444'} strokeWidth="0.6" vectorEffect="non-scaling-stroke" className={m.status === 'open' ? 'marker-pulse' : ''}/>
                  <circle cx={m.mark.x * 100} cy={m.mark.y * 100} r={0.8} fill={m.color || '#ef4444'} />
                  {m.code && (
                    <text x={m.mark.x * 100 + 3.5} y={m.mark.y * 100 + 1} fill={m.color || '#ef4444'} fontSize="2.8" fontFamily="IBM Plex Mono, monospace" fontWeight="600" style={{ paintOrder: 'stroke', stroke: '#000', strokeWidth: '0.8px' }}>{m.code}</text>
                  )}
                </g>
              ))}
              {isPlacing && draft && (
                <g>
                  <circle cx={draft.x * 100} cy={draft.y * 100} r={3.5} fill="none" stroke="#e30613" strokeWidth="1" vectorEffect="non-scaling-stroke" className="marker-pulse"/>
                  <circle cx={draft.x * 100} cy={draft.y * 100} r={1} fill="#e30613" />
                </g>
              )}
            </svg>
          </div>
        ) : (
          // Hidden bootstrap image to measure
          <img
            ref={imgRef}
            src={imageUrl}
            alt=""
            onLoad={onImgLoad}
            style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
          />
        )}

        <div className="zoom-hint">
          <Move size={12}/> {isPlacing ? 'Pinch to zoom · Tap to place marker' : 'Pinch to zoom · Tap a marker to open'}
        </div>
      </div>

      {isPlacing && (
        <div className="zoom-footer">
          <button className="btn btn-ghost" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className="btn btn-primary" onClick={confirm} disabled={!draft} style={{ flex: 2 }}>
            <Check size={16}/> Confirm marker
          </button>
        </div>
      )}
    </div>
  );
}

function LayoutPicker({ image, mark, onChange, readOnly = false }) {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <>
      <div className={`layout-canvas ${readOnly ? '' : 'interactive'}`} onClick={() => !readOnly && setModalOpen(true)}>
        <img src={image} alt="layout" />
        {mark && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <circle cx={mark.x * 100} cy={mark.y * 100} r={3} fill="none" stroke="#ef4444" strokeWidth="0.8" className="marker-pulse" vectorEffect="non-scaling-stroke"/>
            <circle cx={mark.x * 100} cy={mark.y * 100} r={0.8} fill="#ef4444" />
          </svg>
        )}
        {!readOnly && (
          <div className="layout-tap-hint">
            <Maximize2 size={14}/> Tap to zoom &amp; place marker
          </div>
        )}
      </div>
      {modalOpen && !readOnly && (
        <ZoomableLayoutModal
          imageUrl={image}
          initialMark={mark}
          onMarkChange={onChange}
          onClose={() => setModalOpen(false)}
          title="Place marker on layout"
        />
      )}
    </>
  );
}

function NewSnagScreen({ user, project, allSnags, users, onCancel, onCreate }) {
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState(null);
  const [photoMark, setPhotoMark] = useState(null);
  const [mark, setMark] = useState(null);
  const [assignedUserId, setAssignedUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const layoutUrl = useSignedUrl(project?.layout_image_path);

  // Build list of assignable users:
  // - If creator is Leonardo: can assign to ANY user (Leonardo or vendor of this project)
  // - If creator is vendor admin: can only assign to themselves
  const isLeo = user.role === 'leonardo';
  const isVendorAdmin = user.role === 'vendor' && (user.level === 'admin' || user.level === 'founder');

  const assignableUsers = useMemo(() => {
    if (isLeo) {
      return users.filter(u =>
        u.role === 'leonardo' ||
        (u.role === 'vendor' && (project?.vendors || []).includes(u.company))
      );
    } else if (isVendorAdmin) {
      return users.filter(u => u.id === user.id);
    }
    return [];
  }, [users, project, isLeo, isVendorAdmin, user.id]);

  // Default assigned to first vendor of the project (Leonardo) or self (vendor admin)
  useEffect(() => {
    if (!assignedUserId && assignableUsers.length > 0) {
      if (isLeo) {
        // prefer first vendor of the project, otherwise first user
        const firstVendor = assignableUsers.find(u => u.role === 'vendor');
        setAssignedUserId(firstVendor?.id || assignableUsers[0].id);
      } else {
        setAssignedUserId(user.id);
      }
    }
  }, [assignableUsers, assignedUserId, isLeo, user.id]);

  if (!project) return <div className="empty" style={{ marginTop: 24 }}>Project not found.</div>;
  if (!project.layout_image_path) {
    return (
      <div style={{ paddingTop: 24 }}>
        <div className="card card-row">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <AlertCircle color="#f59e0b" size={22} />
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Layout missing</div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Upload a layout from project settings before creating snags.</div>
            </div>
          </div>
        </div>
        <button className="btn btn-ghost" onClick={onCancel} style={{ marginTop: 16, width: '100%' }}>Back</button>
      </div>
    );
  }

  const handlePhoto = async (file) => {
    if (!file) return;
    setBusy(true);
    try { setPhoto(await fileToCompressedDataUrl(file, 1400, 0.75)); }
    catch (e) { console.error(e); }
    setBusy(false);
  };

  const submit = () => {
    if (!title.trim() || !photo || !mark || !assignedUserId || !photoMark) return;
    const assignedUser = users.find(u => u.id === assignedUserId);
    if (!assignedUser) return;
    const userProjectSnags = allSnags.filter(s => s.project_id === project.id && s.created_by === user.id);
    const code = generatePointCode(user, userProjectSnags);
    onCreate({
      code, projectId: project.id, title: title.trim(), description: description.trim(),
      photo, photoMark, mark,
      assignedCompany: assignedUser.company,
      assignedUserId: assignedUser.id,
    });
  };

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {[1,2,3,4,5].map(n => (
          <div key={n} style={{ flex: 1, height: 4, borderRadius: 2, background: step >= n ? 'var(--accent)' : 'var(--border)' }} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', letterSpacing: '0.15em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 8 }}>Step {step} of 5</div>

      {step === 1 && (
        <div className="fadeIn">
          <h2 style={{ fontSize: 22, margin: '0 0 16px' }}>Take a photo of the issue</h2>
          <div style={{ marginBottom: 16 }}>
            {photo ? (
              <div style={{ position: 'relative' }}>
                <img src={photo} alt="" style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border)' }} />
                <button onClick={() => setPhoto(null)} className="btn btn-ghost" style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)' }}><RotateCcw size={14}/> Retake</button>
              </div>
            ) : (
              <label style={{ display: 'block', cursor: 'pointer' }}>
                <div style={{ aspectRatio: '4/3', border: '2px dashed var(--border-strong)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: 'var(--text-dim)', background: 'var(--bg-2)' }}>
                  <Camera size={40} />
                  <div style={{ fontWeight: 600 }}>{busy ? 'Processing…' : 'Take or upload a photo'}</div>
                </div>
                <input type="file" accept="image/*" capture="environment" onChange={e => handlePhoto(e.target.files?.[0])} style={{ display: 'none' }} />
              </label>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
            <button className="btn btn-primary" onClick={() => setStep(2)} disabled={!photo} style={{ flex: 2 }}>Continue</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="fadeIn">
          <h2 style={{ fontSize: 22, margin: '0 0 8px' }}>Mark the point on the photo</h2>
          <p style={{ color: 'var(--text-dim)', margin: '0 0 16px', fontSize: 14 }}>Tap the photo to place an <strong style={{ color: '#ef4444' }}>X</strong> on the exact point.</p>
          <PhotoMarkup image={photo} mark={photoMark} onChange={setPhotoMark}/>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setStep(1)} style={{ flex: 1 }}>Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)} disabled={!photoMark} style={{ flex: 2 }}>Continue</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="fadeIn">
          <h2 style={{ fontSize: 22, margin: '0 0 16px' }}>Describe the issue</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
            <div><label>Short title</label><input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Roller jammed at loading zone" maxLength={80}/></div>
            <div><label>Description</label><textarea value={description} onChange={e => setDescription(e.target.value)} rows={5} placeholder="Context, safety notes…" style={{ resize: 'vertical' }}/></div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setStep(2)} style={{ flex: 1 }}>Back</button>
            <button className="btn btn-primary" onClick={() => setStep(4)} disabled={!title.trim()} style={{ flex: 2 }}>Continue</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="fadeIn">
          <h2 style={{ fontSize: 22, margin: '0 0 8px' }}>Mark the position on the layout</h2>
          <p style={{ color: 'var(--text-dim)', margin: '0 0 16px', fontSize: 14 }}>Tap the layout at the matching point.</p>
          {layoutUrl ? <LayoutPicker image={layoutUrl} mark={mark} onChange={setMark} /> : <div className="empty">Loading layout…</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setStep(3)} style={{ flex: 1 }}>Back</button>
            <button className="btn btn-primary" onClick={() => setStep(5)} disabled={!mark} style={{ flex: 2 }}>Continue</button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="fadeIn">
          <h2 style={{ fontSize: 22, margin: '0 0 16px' }}>Assign and submit</h2>
          <div style={{ marginBottom: 20 }}>
            <label>Assign to</label>
            <select value={assignedUserId} onChange={e => setAssignedUserId(e.target.value)}>
              {assignableUsers.filter(u => u.role === 'leonardo').length > 0 && (
                <optgroup label="Leonardo Spa">
                  {assignableUsers.filter(u => u.role === 'leonardo').map(u => (
                    <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
                  ))}
                </optgroup>
              )}
              {[...new Set(assignableUsers.filter(u => u.role === 'vendor').map(u => u.company))].map(company => (
                <optgroup key={company} label={company}>
                  {assignableUsers.filter(u => u.company === company).map(u => (
                    <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-row">
              <div style={{ fontSize: 11, color: 'var(--text-faint)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 8, fontWeight: 600 }}>Summary</div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
              {description && <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>{description}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setStep(4)} style={{ flex: 1 }}>Back</button>
            <button className="btn btn-primary" onClick={submit} style={{ flex: 2 }}><Check size={16}/> Create snag</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SnagScreen({ user, users, projects, snag, onBack, onResolve, onApprove, onReject, onDelete }) {
  const [resolutionPhoto, setResolutionPhoto] = useState(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [rejectNote, setRejectNote] = useState('');
  const [showResolveForm, setShowResolveForm] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!snag) return <div className="empty" style={{ marginTop: 24 }}>Snag not found.</div>;
  const project = projects.find(p => p.id === snag.project_id);
  const layoutUrl = useSignedUrl(project?.layout_image_path);
  const photoUrl = useSignedUrl(snag.photo_path);
  const resolutionUrl = useSignedUrl(snag.resolution?.photo_path);
  const st = STATUS[snag.status];
  const creator = users.find(u => u.id === snag.created_by);
  const resolver = users.find(u => u.id === snag.resolution?.by);
  const approver = users.find(u => u.id === snag.approval?.by);
  const assignee = users.find(u => u.id === snag.assigned_to);
  const isLeo = user.role === 'leonardo';
  // Vendor of the assigned company OR the user explicitly assigned can resolve
  const isAssignedToMe = snag.assigned_to === user.id;
  const isVendorForThis = user.role === 'vendor' && user.company === snag.assigned_company;
  const canResolve = (isVendorForThis || isAssignedToMe) && snag.status === 'open';
  const canApprove = isLeo && snag.status === 'fixed';

  const handleResolvePhoto = async (file) => {
    if (!file) return;
    setBusy(true);
    try { setResolutionPhoto(await fileToCompressedDataUrl(file, 1400, 0.75)); }
    catch(e) { console.error(e); }
    setBusy(false);
  };

  const submitResolution = async () => {
    if (!resolutionPhoto) return;
    await onResolve(snag, resolutionPhoto, resolutionNote.trim());
    setShowResolveForm(false); setResolutionPhoto(null); setResolutionNote('');
  };

  const submitReject = async () => {
    await onReject(snag, rejectNote.trim());
    setShowRejectForm(false); setRejectNote('');
  };

  const StIcon = st.icon;

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span className="badge" style={{ background: st.bg, color: st.color, border: `1px solid ${st.ring}` }}><StIcon size={12}/> {st.label}</span>
        <span className="mono" style={{ fontSize: 14, color: 'var(--accent)', fontWeight: 600 }}>{snag.code}</span>
      </div>
      <h1 style={{ fontSize: 22, margin: '0 0 8px', lineHeight: 1.25 }}>{snag.title}</h1>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 20 }}>
        Created by {creator ? `${creator.first_name} ${creator.last_name}` : '—'} · {fmtDate(snag.created_at)}<br />
        Assigned to{' '}
        <span style={{ color: 'var(--accent)' }}>
          {assignee
            ? `${assignee.first_name} ${assignee.last_name} · ${assignee.company}`
            : snag.assigned_company}
        </span>
      </div>

      {snag.description && (
        <div className="card card-row" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 6 }}>Description</div>
          <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{snag.description}</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 8 }}>Issue photo</div>
          {photoUrl ? <PhotoMarkup image={photoUrl} mark={snag.photo_mark} onChange={() => {}} readOnly /> : <div className="empty">Loading photo…</div>}
        </div>
        {layoutUrl && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 8 }}>Position on layout</div>
            <LayoutPicker image={layoutUrl} mark={snag.mark} onChange={() => {}} readOnly />
          </div>
        )}
      </div>

      {snag.resolution && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'rgba(245,158,11,0.3)' }}>
          <div style={{ padding: 14, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={16} color="#f59e0b"/><div style={{ fontWeight: 600 }}>Resolution uploaded</div>
          </div>
          <div className="card-row">
            {resolutionUrl ? <img src={resolutionUrl} alt="" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)' }} /> : <div className="empty">Loading…</div>}
            {snag.resolution.note && <div style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{snag.resolution.note}</div>}
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8 }}>
              {resolver ? `${resolver.first_name} ${resolver.last_name} · ${resolver.company}` : '—'} · {fmtDate(snag.resolution.at)}
            </div>
          </div>
        </div>
      )}

      {snag.approval && snag.status === 'approved' && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'rgba(16,185,129,0.3)' }}>
          <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle2 size={16} color="#10b981"/>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Approved</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{approver ? `${approver.first_name} ${approver.last_name}` : '—'} · {fmtDate(snag.approval.at)}</div>
            </div>
          </div>
        </div>
      )}

      {canResolve && !showResolveForm && (
        <button className="btn btn-primary" onClick={() => setShowResolveForm(true)} style={{ width: '100%', marginBottom: 12 }}>
          <Camera size={16}/> Mark as resolved and upload photo
        </button>
      )}

      {canResolve && showResolveForm && (
        <div className="card card-row fadeIn" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Upload resolution photo</div>
          {resolutionPhoto ? (
            <div style={{ position: 'relative', marginBottom: 12 }}>
              <img src={resolutionPhoto} alt="" style={{ width: '100%', borderRadius: 8 }} />
              <button onClick={() => setResolutionPhoto(null)} className="btn btn-ghost" style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.6)'}}><RotateCcw size={14}/></button>
            </div>
          ) : (
            <label style={{ display: 'block', cursor: 'pointer', marginBottom: 12 }}>
              <div style={{ aspectRatio: '4/3', border: '2px dashed var(--border-strong)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: 'var(--text-dim)' }}>
                <Camera size={32}/><div>{busy ? 'Processing…' : 'Take photo'}</div>
              </div>
              <input type="file" accept="image/*" capture="environment" onChange={e => handleResolvePhoto(e.target.files?.[0])} style={{ display: 'none' }}/>
            </label>
          )}
          <label>Notes (optional)</label>
          <textarea value={resolutionNote} onChange={e => setResolutionNote(e.target.value)} rows={3} placeholder="How was it resolved…" style={{ resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-ghost" onClick={() => { setShowResolveForm(false); setResolutionPhoto(null); }} style={{ flex: 1 }}>Cancel</button>
            <button className="btn btn-primary" onClick={submitResolution} disabled={!resolutionPhoto} style={{ flex: 2 }}>Submit for approval</button>
          </div>
        </div>
      )}

      {canApprove && !showRejectForm && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button className="btn btn-danger" onClick={() => setShowRejectForm(true)} style={{ flex: 1 }}><X size={16}/> Reject</button>
          <button className="btn btn-success" onClick={() => onApprove(snag)} style={{ flex: 2 }}><Check size={16}/> Approve</button>
        </div>
      )}

      {canApprove && showRejectForm && (
        <div className="card card-row fadeIn" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Rejection reason</div>
          <textarea value={rejectNote} onChange={e => setRejectNote(e.target.value)} rows={3} placeholder="Why the resolution is not acceptable…"/>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-ghost" onClick={() => setShowRejectForm(false)} style={{ flex: 1 }}>Cancel</button>
            <button className="btn btn-danger" onClick={submitReject} disabled={!rejectNote.trim()} style={{ flex: 2 }}>Reject and reopen</button>
          </div>
        </div>
      )}

      {snag.history && snag.history.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-faint)', letterSpacing: '0.15em', textTransform: 'uppercase', fontWeight: 600 }}>History</div>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {snag.history.slice().reverse().map((h, i) => {
              const who = users.find(u => u.id === h.by);
              return (
                <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                  <div style={{ width: 8, height: 8, marginTop: 6, borderRadius: 4, background: 'var(--accent)', flexShrink: 0 }}/>
                  <div style={{ flex: 1 }}>
                    <div>{who ? `${who.first_name} ${who.last_name}` : '—'} · <span style={{ color: 'var(--text-dim)' }}>{actionLabel(h.action)}</span></div>
                    {h.note && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2, fontStyle: 'italic' }}>"{h.note}"</div>}
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{fmtDate(h.at)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isLeo && (
        <button className="btn btn-danger" onClick={() => { if (confirm('Permanently delete this snag?')) onDelete(snag.id); }} style={{ width: '100%', marginTop: 20 }}>
          <Trash2 size={14}/> Delete snag
        </button>
      )}
    </div>
  );
}

function actionLabel(a) {
  return ({ created: 'created the snag', resolved: 'uploaded the resolution', approved: 'approved', rejected: 'rejected, snag reopened' })[a] || a;
}

function NewProjectScreen({ user, users, onCancel, onCreate }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [layoutImage, setLayoutImage] = useState(null);
  const vendorCompanies = useMemo(() => [...new Set(users.filter(u => u.role === 'vendor').map(u => u.company))], [users]);
  const [selectedVendors, setSelectedVendors] = useState([]);
  const [busy, setBusy] = useState(false);

  const handleLayout = async (file) => {
    if (!file) return;
    setBusy(true);
    try { setLayoutImage(await fileToCompressedDataUrl(file, 2000, 0.8)); }
    catch(e) { console.error(e); }
    setBusy(false);
  };
  const useBhx2Preset = () => setLayoutImage(ASSET_LAYOUT_PRESET_BHX2);
  const toggleVendor = (v) => setSelectedVendors(s => s.includes(v) ? s.filter(x => x !== v) : [...s, v]);

  const submit = () => {
    if (!name.trim()) return;
    onCreate({ name: name.trim(), description: description.trim(), layoutImage, vendors: selectedVendors });
  };

  return (
    <div style={{ paddingTop: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div><label>Project name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="es. Amazon BHX2"/></div>
      <div><label>Description</label><textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}/></div>
      <div>
        <label>Plant layout</label>
        {layoutImage ? (
          <div style={{ position: 'relative' }}>
            <img src={layoutImage} alt="" style={{ width: '100%', borderRadius: 10, border: '1px solid var(--border)' }}/>
            <button onClick={() => setLayoutImage(null)} className="btn btn-ghost" style={{ position:'absolute', top:8, right:8, background:'rgba(0,0,0,0.6)'}}><RotateCcw size={14}/></button>
          </div>
        ) : (
          <>
            <label style={{ cursor: 'pointer', display: 'block' }}>
              <div style={{ aspectRatio: '16/9', border: '2px dashed var(--border-strong)', borderRadius: 10, display: 'flex', alignItems:'center', justifyContent:'center', gap: 8, flexDirection: 'column', color: 'var(--text-dim)' }}>
                <Upload size={28}/><div>{busy ? 'Processing…' : 'Upload layout'}</div>
              </div>
              <input type="file" accept="image/*" onChange={e => handleLayout(e.target.files?.[0])} style={{ display: 'none' }}/>
            </label>
            <button className="btn btn-ghost" onClick={useBhx2Preset} style={{ marginTop: 8, width: '100%', fontSize: 12 }}>Use BHX2 demo layout</button>
          </>
        )}
      </div>
      <div>
        <label>Vendors</label>
        {vendorCompanies.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-dim)', padding: 12, border: '1px dashed var(--border)', borderRadius: 8 }}>
            No vendors registered yet. Share the app link with your vendors — once they sign up you'll be able to add them to projects.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {vendorCompanies.map(v => (
              <button key={v} onClick={() => toggleVendor(v)} className="card" style={{ textAlign: 'left', padding: 12, color: 'inherit', display: 'flex', alignItems: 'center', gap: 10, borderColor: selectedVendors.includes(v) ? 'var(--accent)' : 'var(--border)' }}>
                <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${selectedVendors.includes(v) ? 'var(--accent)' : 'var(--border-strong)'}`, background: selectedVendors.includes(v) ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {selectedVendors.includes(v) && <Check size={12} color="#fff"/>}
                </div>
                <span>{v}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-ghost" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={!name.trim()} style={{ flex: 2 }}>Crea</button>
      </div>
    </div>
  );
}

function ProjectSettingsScreen({ project, user, users, onBack, onUpdate, onDelete }) {
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [layoutImage, setLayoutImage] = useState(null); // new base64 if user re-uploads
  const currentLayoutUrl = useSignedUrl(project?.layout_image_path);
  const vendorCompanies = useMemo(() => [...new Set(users.filter(u => u.role === 'vendor').map(u => u.company))], [users]);
  const [selectedVendors, setSelectedVendors] = useState(project?.vendors || []);
  const [busy, setBusy] = useState(false);

  if (!project) return <div className="empty" style={{ marginTop: 24 }}>Project not found.</div>;

  const handleLayout = async (file) => {
    if (!file) return;
    setBusy(true);
    try { setLayoutImage(await fileToCompressedDataUrl(file, 2000, 0.8)); }
    catch(e) { console.error(e); }
    setBusy(false);
  };
  const toggleVendor = (v) => setSelectedVendors(s => s.includes(v) ? s.filter(x => x !== v) : [...s, v]);
  const save = () => onUpdate(project, { name: name.trim(), description: description.trim(), layoutImage: layoutImage || project.layout_image_path, vendors: selectedVendors });
  const displayedLayout = layoutImage || currentLayoutUrl;

  return (
    <div style={{ paddingTop: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div><label>First name</label><input value={name} onChange={e => setName(e.target.value)}/></div>
      <div><label>Description</label><textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}/></div>
      <div>
        <label>Plant layout</label>
        {displayedLayout ? (
          <div style={{ position: 'relative' }}>
            <img src={displayedLayout} alt="" style={{ width: '100%', borderRadius: 10, border: '1px solid var(--border)' }}/>
            <label style={{ position: 'absolute', top: 8, right: 8, cursor: 'pointer' }}>
              <div className="btn btn-ghost" style={{ background: 'rgba(0,0,0,0.6)'}}><Edit3 size={14}/> Replace</div>
              <input type="file" accept="image/*" onChange={e => handleLayout(e.target.files?.[0])} style={{ display: 'none' }}/>
            </label>
          </div>
        ) : (
          <label style={{ cursor: 'pointer', display: 'block' }}>
            <div style={{ aspectRatio: '16/9', border: '2px dashed var(--border-strong)', borderRadius: 10, display: 'flex', alignItems:'center', justifyContent:'center', gap: 8, flexDirection: 'column', color: 'var(--text-dim)' }}>
              <Upload size={28}/><div>{busy ? 'Processing…' : 'Upload layout'}</div>
            </div>
            <input type="file" accept="image/*" onChange={e => handleLayout(e.target.files?.[0])} style={{ display: 'none' }}/>
          </label>
        )}
      </div>
      <div>
        <label>Vendors</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {vendorCompanies.map(v => (
            <button key={v} onClick={() => toggleVendor(v)} className="card" style={{ textAlign: 'left', padding: 12, color: 'inherit', display: 'flex', alignItems: 'center', gap: 10, borderColor: selectedVendors.includes(v) ? 'var(--accent)' : 'var(--border)' }}>
              <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${selectedVendors.includes(v) ? 'var(--accent)' : 'var(--border-strong)'}`, background: selectedVendors.includes(v) ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {selectedVendors.includes(v) && <Check size={12} color="#fff"/>}
              </div>
              <span>{v}</span>
            </button>
          ))}
        </div>
      </div>
      <button className="btn btn-primary" onClick={save}>Save changes</button>
      <button className="btn btn-danger" onClick={() => { if (confirm(`Delete "${project.name}" and all its snags?`)) onDelete(project.id); }}>
        <Trash2 size={14}/> Delete project
      </button>
    </div>
  );
}

function UsersScreen({ user, users, onBack, onShowToast, onSetLevel, onDeleteUser }) {
  const leo = users.filter(u => u.role === 'leonardo');
  const vendors = users.filter(u => u.role === 'vendor');
  const isFounder = user.level === 'founder';
  const isAdmin = user.level === 'admin' || isFounder;

  // Group vendors by company
  const vendorByCompany = useMemo(() => {
    const map = {};
    for (const v of vendors) {
      if (!map[v.company]) map[v.company] = [];
      map[v.company].push(v);
    }
    return map;
  }, [vendors]);

  return (
    <div style={{ paddingTop: 20 }}>
      <div className="card card-row" style={{ marginBottom: 20, background: 'var(--accent-soft)', borderColor: 'rgba(227,6,19,0.3)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <UserPlus color="var(--accent)" size={22} />
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text)' }}>How permissions work</div>
            <strong>Founder ★</strong> can promote, demote and delete anyone (including admins). <strong>Admin ◆</strong> can promote members to admin and delete members. <strong>Members</strong> can only use the app. New sign-ups join as members.
          </div>
        </div>
      </div>

      <div style={{ fontSize: 11, letterSpacing: '0.15em', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 10, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Shield size={12}/> Leonardo Spa ({leo.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
        {leo.map(u => (
          <UserRow
            key={u.id} u={u} currentUser={user}
            isFounder={isFounder} isAdmin={isAdmin}
            onSetLevel={onSetLevel} onDeleteUser={onDeleteUser}
          />
        ))}
      </div>

      {Object.keys(vendorByCompany).length > 0 && (
        <>
          <div style={{ fontSize: 11, letterSpacing: '0.15em', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 10, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Building2 size={12}/> Vendors ({vendors.length})
          </div>
          {Object.entries(vendorByCompany).map(([company, list]) => (
            <div key={company} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 6, paddingLeft: 4 }}>
                {company} ({list.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {list.map(u => (
                  <UserRow
                    key={u.id} u={u} currentUser={user}
                    isFounder={isFounder} isAdmin={isAdmin}
                    onSetLevel={onSetLevel} onDeleteUser={onDeleteUser}
                  />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function UserRow({ u, currentUser, isFounder, isAdmin, onSetLevel, onDeleteUser }) {
  const initials = ((u.first_name?.[0] || '') + (u.last_name?.[0] || '')).toUpperCase();
  const isMe = u.id === currentUser.id;
  const isTheirFounder = u.level === 'founder';
  const isTheirAdmin = u.level === 'admin';
  const isTheirMember = u.level === 'member' || !u.level;

  // Permission rules:
  // - Nobody can act on themselves from this screen
  // - Nobody can act on a founder
  // - Founder can do anything to admins and members
  // - Admin can: promote member→admin, demote admin→member (NOT founder), delete members
  // - Member: no buttons
  const canPromote =
    !isMe && !isTheirFounder && isTheirMember && isAdmin;
  const canDemote =
    !isMe && !isTheirFounder && isTheirAdmin && (isFounder || isAdmin);
  const canDelete =
    !isMe && !isTheirFounder && (
      isFounder ||
      (isAdmin && isTheirMember)
    );

  const levelBadge = isTheirFounder ? '★ FOUNDER'
    : isTheirAdmin ? '◆ ADMIN'
    : null;

  return (
    <div className="card card-row" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{
        width: 40, height: 40, borderRadius: 20,
        background: u.role === 'leonardo' ? 'var(--accent-soft)' : 'var(--surface-2)',
        color: u.role === 'leonardo' ? 'var(--accent)' : 'var(--text)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 600, fontSize: 13, flexShrink: 0
      }}>{initials}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>{u.first_name} {u.last_name}</span>
          {isMe && <span style={{ color: 'var(--text-faint)', fontSize: 11, fontWeight: 400 }}>· you</span>}
          {levelBadge && (
            <span className="mono" style={{
              fontSize: 9, letterSpacing: '0.1em',
              padding: '2px 6px', borderRadius: 4,
              background: isTheirFounder ? 'rgba(227,6,19,0.18)' : 'rgba(255,255,255,0.06)',
              color: isTheirFounder ? 'var(--accent)' : 'rgba(255,255,255,0.75)',
              border: isTheirFounder ? '1px solid rgba(227,6,19,0.35)' : '1px solid var(--border)',
            }}>{levelBadge}</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.email}</div>
      </div>

      {(canPromote || canDemote || canDelete) && (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {canPromote && (
            <button
              className="icon-btn"
              title="Promote to admin"
              onClick={() => { if (confirm(`Promote ${u.first_name} ${u.last_name} to admin?`)) onSetLevel(u.id, 'admin'); }}
              style={{ background: 'rgba(227,6,19,0.1)', color: 'var(--accent)' }}
            >
              <Shield size={16}/>
            </button>
          )}
          {canDemote && (
            <button
              className="icon-btn"
              title="Demote to member"
              onClick={() => { if (confirm(`Demote ${u.first_name} ${u.last_name} to member?`)) onSetLevel(u.id, 'member'); }}
              style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}
            >
              <RotateCcw size={16}/>
            </button>
          )}
          {canDelete && (
            <button
              className="icon-btn"
              title="Delete account"
              onClick={() => { if (confirm(`Delete ${u.first_name} ${u.last_name}'s account? This cannot be undone.`)) onDeleteUser(u.id); }}
              style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
            >
              <Trash2 size={16}/>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WhatsNewModal({ onClose }) {
  const iconMap = {
    Sparkles, Bug, Maximize2, UserCog, UserPlus, Users, ListChecks, Shield, Camera,
  };
  // Lock body scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div className="whatsnew-backdrop" onClick={onClose}>
      <div className="whatsnew-modal" onClick={e => e.stopPropagation()}>
        <button className="whatsnew-close" onClick={onClose} aria-label="Close"><X size={20}/></button>
        <div className="whatsnew-header">
          <div className="whatsnew-version-pill">v{PATCH_NOTES.version}</div>
          <div className="whatsnew-eyebrow">{PATCH_NOTES.subtitle}</div>
          <h2 className="whatsnew-title">{PATCH_NOTES.title}</h2>
          <p className="whatsnew-lead">A few improvements based on field feedback. Tap any item to read the detail.</p>
        </div>

        <div className="whatsnew-list">
          {PATCH_NOTES.items.map((item, i) => {
            const Ico = iconMap[item.icon] || Sparkles;
            return (
              <div key={i} className="whatsnew-item">
                <div className="whatsnew-item-icon"><Ico size={18}/></div>
                <div className="whatsnew-item-body">
                  <div className="whatsnew-item-title">{item.title}</div>
                  <div className="whatsnew-item-detail">{item.detail}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="whatsnew-footer">
          <button className="btn btn-primary" onClick={onClose} style={{ width: '100%' }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast({ msg, kind }) {
  const colors = { success: '#10b981', info: '#9ba1ab', error: '#ef4444' };
  return <div className="toast" style={{ color: colors[kind] || colors.info }}>{msg}</div>;
}

// =============================================================
// STYLES
// =============================================================
function StyleTag() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

      :root {
        --bg: #0b0d10; --bg-2: #111419;
        --surface: #161a21; --surface-2: #1d222b;
        --border: #252b35; --border-strong: #343c4a;
        --text: #e8eaed; --text-dim: #9ba1ab; --text-faint: #5c636e;
        --leo-red: #e30613; --accent: #e30613;
        --accent-soft: rgba(227,6,19,0.14);
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); }
      .sl-root {
        min-height: 100vh;
        background: var(--bg);
        background-image:
          radial-gradient(1000px 600px at 100% -10%, rgba(227,6,19,0.06), transparent 60%),
          radial-gradient(800px 500px at -10% 100%, rgba(16,185,129,0.04), transparent 60%);
        color: var(--text);
        font-family: 'IBM Plex Sans', system-ui, sans-serif;
        font-size: 15px;
        max-width: 560px; margin: 0 auto;
        min-height: 100dvh;
        display: flex; flex-direction: column;
      }
      .mono { font-family: 'IBM Plex Mono', monospace; }
      .sl-main { flex: 1; padding: 0 16px 96px; }
      button { font-family: inherit; cursor: pointer; }
      input, textarea, select {
        font-family: inherit; font-size: 15px;
        background: var(--bg-2); color: var(--text);
        border: 1px solid var(--border); border-radius: 10px;
        padding: 12px 14px; outline: none; width: 100%;
        transition: border-color .15s ease;
      }
      input:focus, textarea:focus, select:focus { border-color: var(--accent); }
      label { display:block; font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-dim); margin-bottom: 6px; font-weight: 600;}

      .btn { display:inline-flex; align-items:center; justify-content:center; gap: 8px; padding: 12px 18px; border-radius: 10px; font-weight: 600; font-size: 14px; border: 1px solid transparent; transition: all .15s ease; min-height: 44px; }
      .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
      .btn-primary:hover { filter: brightness(1.1); }
      .btn-primary:disabled { opacity: .4; cursor: not-allowed; }
      .btn-ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
      .btn-ghost:hover { background: var(--surface-2); }
      .btn-danger { background: transparent; color: #ef4444; border-color: rgba(239,68,68,0.3); }
      .btn-danger:hover { background: rgba(239,68,68,0.08); }
      .btn-success { background: #10b981; color: #0b0d10; border-color: #10b981; }
      .btn-success:hover { filter: brightness(1.08); }

      .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
      .card-row { padding: 16px; }
      .card-hover:hover { border-color: var(--border-strong); background: var(--surface-2); }

      .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }

      .fab { position: fixed; bottom: 24px; right: calc(50% - 272px + 16px); z-index: 10; }
      @media (max-width: 560px) { .fab { right: 16px; } }
      .fab button { background: var(--accent); color: #fff; width: 56px; height: 56px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 30px rgba(227,6,19,0.4), 0 0 0 1px rgba(227,6,19,0.5); transition: transform .15s ease; }
      .fab button:hover { transform: scale(1.05); }

      .topbar { position: sticky; top: 0; z-index: 20; background: rgba(11,13,16,0.85); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--border); padding: 12px 16px; display: flex; align-items: center; gap: 12px; }
      .icon-btn { background: transparent; border: none; color: var(--text); width: 40px; height: 40px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; }
      .icon-btn:hover { background: var(--surface-2); }

      .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px; flex: 1; min-width: 0; }
      .stat-num { font-size: 24px; font-weight: 700; font-family: 'IBM Plex Mono', monospace; }
      .stat-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); margin-top: 2px; }

      .layout-canvas { position: relative; width: 100%; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--bg-2); }
      .layout-canvas img { display: block; width: 100%; user-select: none; -webkit-user-drag: none; pointer-events: none; }
      .layout-canvas svg { position: absolute; inset: 0; width: 100%; height: 100%; }
      .layout-canvas.interactive { cursor: crosshair; touch-action: none; }

      .markup-canvas { position: relative; width: 100%; background: #000; border-radius: 12px; overflow: hidden; touch-action: none; }
      .markup-canvas img { display: block; width: 100%; user-select: none; -webkit-user-drag: none; pointer-events: none; }
      .markup-canvas svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
      .markup-canvas.interactive { cursor: crosshair; }

      .codes-row { display: flex; gap: 6px; overflow-x: auto; padding: 4px 0 10px; scrollbar-width: none; }
      .codes-row::-webkit-scrollbar { display: none; }
      .code-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 600; flex-shrink: 0; border: 1px solid; background: rgba(239,68,68,0.08); color: #ef4444; border-color: rgba(239,68,68,0.3); cursor: pointer; transition: all .15s ease; }
      .code-chip:hover { background: rgba(239,68,68,0.15); }
      .code-chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #ef4444; }

      .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 24px; z-index: 100; background: var(--surface); border: 1px solid var(--border-strong); padding: 12px 18px; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.4); animation: toastIn .2s ease; }
      @keyframes toastIn { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }

      .fadeIn { animation: fadeIn .25s ease; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

      .empty { padding: 48px 20px; text-align: center; color: var(--text-dim); border: 1px dashed var(--border-strong); border-radius: 14px; }

      .tab-bar { display: flex; gap: 4px; padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
      .tab-bar button { flex: 1; border: none; background: transparent; color: var(--text-dim); padding: 10px; border-radius: 8px; font-weight: 600; font-size: 13px; }
      .tab-bar button.active { background: var(--surface-2); color: var(--text); }

      .marker-pulse { animation: pulse 2s ease-in-out infinite; }
      @keyframes pulse { 0%, 100% { opacity: 0.9; } 50% { opacity: 0.5; } }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

      /* ===== LOGIN ===== */
      .login-root { position: relative; min-height: 100vh; min-height: 100dvh; overflow: hidden; background: #000; color: #fff; font-family: 'IBM Plex Sans', system-ui, sans-serif; display: flex; flex-direction: column; justify-content: flex-end; }

      .slideshow { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; z-index: 0; background: #000; }
      .slide { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; user-select: none; -webkit-user-drag: none; pointer-events: none; transform-origin: center; will-change: transform, opacity; }
      .slide-prev { opacity: 1; animation: slidePrevOut 1400ms ease-out forwards; }
      .slide-curr { opacity: 0; animation: slideCurrIn 4200ms ease-out forwards; }
      @keyframes slidePrevOut { 0% { opacity: 1; transform: scale(1.10); } 100% { opacity: 0; transform: scale(1.14); } }
      @keyframes slideCurrIn { 0% { opacity: 0; transform: scale(1.00) translate(0, 0); } 25% { opacity: 1; } 100% { opacity: 1; transform: scale(1.10) translate(-1%, -1%); } }
      .slide-pulse { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse at 50% 50%, rgba(227,6,19,0.28), transparent 65%); opacity: 0; transition: opacity 900ms ease-out; mix-blend-mode: screen; }
      .slide-pulse.active { opacity: 1; }

      .login-overlay { position: absolute; inset: 0; z-index: 1; background: radial-gradient(ellipse at 50% 40%, transparent 0%, rgba(0,0,0,0.15) 50%, rgba(0,0,0,0.6) 100%), linear-gradient(180deg, rgba(0,0,0,0.25) 0%, transparent 20%, transparent 50%, rgba(0,0,0,0.85) 100%); }
      .login-scanlines { position: absolute; inset: 0; z-index: 2; pointer-events: none; background-image: repeating-linear-gradient(180deg, rgba(255,255,255,0.01) 0, rgba(255,255,255,0.01) 1px, transparent 1px, transparent 3px); mix-blend-mode: overlay; }
      .login-grain { position: absolute; inset: 0; z-index: 3; pointer-events: none; opacity: 0.05; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='200' height='200' filter='url(%23n)'/></svg>"); }

      .login-content { position: relative; z-index: 10; padding: 24px; padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 24px); max-width: 560px; margin: 0 auto; width: 100%; }

      .login-top { position: absolute; top: 0; left: 0; right: 0; z-index: 10; padding: 28px 24px 20px; display: flex; justify-content: space-between; align-items: center; background: linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, transparent 100%); }
      .login-top::after { content: ''; position: absolute; left: 24px; right: 24px; bottom: 12px; height: 1px; background: linear-gradient(90deg, transparent 0%, rgba(227,6,19,0.5) 20%, rgba(227,6,19,0.2) 50%, transparent 100%); }
      .login-logo-wrap { display: flex; align-items: center; gap: 14px; }
      .login-logo { height: 30px; width: auto; display: block; filter: drop-shadow(0 0 18px rgba(227,6,19,0.35)) drop-shadow(0 2px 6px rgba(0,0,0,0.4)); }
      .login-logo-divider { width: 1px; height: 22px; background: linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.35) 50%, transparent 100%); }
      .login-logo-tag { font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.3em; color: rgba(255,255,255,0.55); text-transform: uppercase; line-height: 1.4; }
      .login-logo-tag strong { display: block; color: rgba(255,255,255,0.92); font-weight: 500; letter-spacing: 0.25em; font-size: 10px; }
      .login-brand-meta { text-align: right; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.25em; color: rgba(255,255,255,0.7); }
      .login-brand-meta .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--leo-red); margin-right: 6px; vertical-align: middle; box-shadow: 0 0 12px var(--leo-red); animation: pulseDot 2s ease-in-out infinite; }
      @keyframes pulseDot { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

      .login-hero { margin-bottom: 32px; }
      .login-title { font-size: 62px; font-weight: 700; letter-spacing: -0.04em; line-height: 0.9; margin: 0 0 8px; color: #fff; text-shadow: 0 4px 24px rgba(0,0,0,0.8), 0 0 40px rgba(227,6,19,0.2); font-family: 'IBM Plex Sans', system-ui, sans-serif; }
      .login-descriptor { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.28em; color: rgba(255,255,255,0.85); text-transform: uppercase; margin: 0 0 18px; padding-bottom: 14px; position: relative; text-shadow: 0 2px 10px rgba(0,0,0,0.7); }
      .login-descriptor::after { content: ''; position: absolute; left: 0; bottom: 0; width: 36px; height: 2px; background: var(--leo-red); box-shadow: 0 0 12px rgba(227,6,19,0.6); }
      .login-subtitle { font-size: 22px; font-weight: 500; letter-spacing: 0.02em; color: var(--leo-red); margin: 0 0 10px; text-shadow: 0 2px 12px rgba(0,0,0,0.6); }
      .login-tagline { color: rgba(255,255,255,0.72); font-size: 14px; margin: 0; max-width: 360px; letter-spacing: 0.03em; text-shadow: 0 2px 10px rgba(0,0,0,0.6); }
      .login-credit {
        margin-top: 22px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.18em;
        color: rgba(255,255,255,0.45);
        text-transform: uppercase;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .login-credit strong {
        color: rgba(255,255,255,0.85);
        font-weight: 500;
        letter-spacing: 0.08em;
      }
      .login-version {
        margin-left: auto;
        padding: 3px 8px;
        border-radius: 999px;
        background: rgba(227,6,19,0.15);
        color: var(--leo-red);
        border: 1px solid rgba(227,6,19,0.3);
        font-weight: 600;
        letter-spacing: 0.1em;
      }

      .login-form { display: flex; flex-direction: column; gap: 10px; }
      .login-form input { background: rgba(0,0,0,0.55); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 14px 16px; border-radius: 10px; font-size: 15px; outline: none; transition: all .2s ease; flex: 1; }
      .login-form input::placeholder { color: rgba(255,255,255,0.4); }
      .login-form input:focus { border-color: var(--leo-red); background: rgba(0,0,0,0.7); }
      .login-form .btn-login { background: var(--leo-red); color: #fff; border: none; padding: 14px; border-radius: 10px; font-weight: 600; font-size: 15px; cursor: pointer; margin-top: 6px; letter-spacing: 0.02em; box-shadow: 0 8px 24px rgba(227,6,19,0.35); transition: all .15s ease; display: flex; align-items: center; justify-content: center; }
      .login-form .btn-login:hover { filter: brightness(1.1); transform: translateY(-1px); }
      .login-form .btn-login:disabled { opacity: .6; cursor: wait; }
      .login-error { color: #ff6b6b; font-size: 13px; padding: 4px 0; }

      .corner { position: absolute; width: 18px; height: 18px; border-color: rgba(227,6,19,0.6); z-index: 5; }
      .corner.tl { top: 24px; left: 24px; border-top: 2px solid; border-left: 2px solid; }
      .corner.tr { top: 24px; right: 24px; border-top: 2px solid; border-right: 2px solid; }
      .corner.bl { bottom: 24px; left: 24px; border-bottom: 2px solid; border-left: 2px solid; }
      .corner.br { bottom: 24px; right: 24px; border-bottom: 2px solid; border-right: 2px solid; }

      /* ===== ZOOMABLE LAYOUT MODAL ===== */
      .zoom-modal-backdrop {
        position: fixed; inset: 0; z-index: 1000;
        background: #000;
        display: flex; flex-direction: column;
        animation: zoomModalIn 200ms ease-out;
      }
      @keyframes zoomModalIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .zoom-header {
        position: relative; z-index: 10;
        padding: 14px 12px;
        background: rgba(11,13,16,0.92);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex; align-items: center; gap: 10px;
        padding-top: calc(env(safe-area-inset-top, 0px) + 14px);
      }
      .zoom-title {
        flex: 1;
        font-size: 14px; font-weight: 600;
        color: rgba(255,255,255,0.9);
        text-align: center;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .zoom-controls { display: flex; align-items: center; gap: 2px; }
      .zoom-icon-btn {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.9);
        width: 36px; height: 36px; border-radius: 8px;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background 0.15s ease;
      }
      .zoom-icon-btn:hover, .zoom-icon-btn:active {
        background: rgba(255,255,255,0.12);
      }
      .zoom-pct {
        background: transparent; border: none;
        color: rgba(255,255,255,0.7);
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px; font-weight: 600;
        padding: 6px 10px; border-radius: 6px;
        min-width: 46px; cursor: pointer;
      }
      .zoom-pct:hover { background: rgba(255,255,255,0.08); }

      .zoom-viewport {
        flex: 1;
        position: relative;
        overflow: hidden;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        background: #000;
      }
      .zoom-canvas {
        position: absolute;
        top: 0; left: 0;
        will-change: transform;
      }
      .zoom-canvas img {
        display: block;
        width: 100%; height: auto;
        user-select: none; -webkit-user-drag: none;
        pointer-events: none;
      }
      .zoom-markers-svg {
        position: absolute; inset: 0;
        width: 100%; height: 100%;
        pointer-events: none;
      }
      .zoom-hint {
        position: absolute;
        bottom: 16px; left: 50%;
        transform: translateX(-50%);
        z-index: 5;
        background: rgba(0,0,0,0.7);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: rgba(255,255,255,0.75);
        font-size: 11px; letter-spacing: 0.05em;
        padding: 8px 14px; border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.1);
        display: inline-flex; align-items: center; gap: 6px;
        pointer-events: none;
        animation: zoomHintPulse 3s ease-in-out infinite;
      }
      @keyframes zoomHintPulse {
        0%, 100% { opacity: 0.7; }
        50% { opacity: 1; }
      }
      .zoom-footer {
        padding: 14px 16px;
        padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 14px);
        background: rgba(11,13,16,0.92);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border-top: 1px solid rgba(255,255,255,0.08);
        display: flex; gap: 8px;
      }

      /* Tap hint on inline layout preview */
      .layout-tap-hint {
        position: absolute;
        bottom: 10px; right: 10px;
        background: rgba(0,0,0,0.65);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        color: rgba(255,255,255,0.85);
        font-size: 11px; font-weight: 500;
        padding: 6px 10px; border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.12);
        display: inline-flex; align-items: center; gap: 5px;
        pointer-events: none;
      }

      /* ===== What's New Modal ===== */
      .whatsnew-backdrop {
        position: fixed; inset: 0; z-index: 200;
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        animation: whatsnewFadeIn 0.25s ease-out;
      }
      @keyframes whatsnewFadeIn {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      .whatsnew-modal {
        position: relative;
        width: 100%; max-width: 480px;
        max-height: calc(100dvh - 40px);
        background: linear-gradient(180deg, #181c25 0%, #11141b 100%);
        border: 1px solid var(--border-strong);
        border-radius: 18px;
        overflow: hidden;
        display: flex; flex-direction: column;
        box-shadow:
          0 24px 64px rgba(0, 0, 0, 0.6),
          0 0 0 1px rgba(255, 255, 255, 0.04) inset,
          0 0 80px rgba(227, 6, 19, 0.08);
        animation: whatsnewSlideUp 0.3s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      @keyframes whatsnewSlideUp {
        from { opacity: 0; transform: translateY(20px) scale(0.96); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .whatsnew-close {
        position: absolute; top: 14px; right: 14px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.08);
        color: var(--text-dim);
        width: 32px; height: 32px; border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; z-index: 2;
        transition: all .15s ease;
      }
      .whatsnew-close:hover { background: rgba(255,255,255,0.1); color: var(--text); }
      .whatsnew-header {
        padding: 28px 24px 20px;
        border-bottom: 1px solid var(--border);
        background:
          radial-gradient(ellipse at top, rgba(227,6,19,0.12) 0%, transparent 70%);
      }
      .whatsnew-version-pill {
        display: inline-block;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; font-weight: 600;
        letter-spacing: 0.15em;
        color: var(--leo-red);
        background: rgba(227,6,19,0.12);
        border: 1px solid rgba(227,6,19,0.3);
        padding: 4px 10px; border-radius: 999px;
        margin-bottom: 12px;
      }
      .whatsnew-eyebrow {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.2em;
        color: var(--text-faint);
        text-transform: uppercase;
        margin-bottom: 6px;
      }
      .whatsnew-title {
        font-size: 26px; font-weight: 700;
        letter-spacing: -0.02em;
        margin: 0 0 8px;
        color: var(--text);
      }
      .whatsnew-lead {
        font-size: 13px; color: var(--text-dim);
        margin: 0; line-height: 1.5;
      }
      .whatsnew-list {
        flex: 1; overflow-y: auto;
        padding: 16px 20px;
        display: flex; flex-direction: column; gap: 14px;
      }
      .whatsnew-item {
        display: flex; gap: 14px;
        padding: 14px;
        background: rgba(255,255,255,0.02);
        border: 1px solid var(--border);
        border-radius: 12px;
        transition: all .15s ease;
      }
      .whatsnew-item:hover {
        background: rgba(255,255,255,0.04);
        border-color: var(--border-strong);
      }
      .whatsnew-item-icon {
        width: 36px; height: 36px;
        border-radius: 10px;
        background: var(--accent-soft);
        color: var(--accent);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .whatsnew-item-body { flex: 1; min-width: 0; }
      .whatsnew-item-title {
        font-size: 14px; font-weight: 600;
        color: var(--text); margin-bottom: 4px;
        line-height: 1.3;
      }
      .whatsnew-item-detail {
        font-size: 12px;
        color: var(--text-dim);
        line-height: 1.5;
      }
      .whatsnew-footer {
        padding: 16px 20px;
        padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
        border-top: 1px solid var(--border);
        background: rgba(11,13,16,0.4);
      }
    `}</style>
  );
}

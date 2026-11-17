import React, { useEffect, useState } from 'react';
import { KeyRound, MessageSquare, UserCheck, UserPlus, X } from 'lucide-react';
import type { BootstrapData, LangCode } from '../types';
import { apiFetch } from '../utils/api';

interface AuthSmsModalProps {
  open: boolean;
  initialMode: 'account' | 'register' | 'sms';
  onClose: () => void;
  bootstrap: BootstrapData;
  lang: LangCode;
  sessionToken: string | null;
  onSessionChange: (token: string | null) => void;
  onRefresh: () => Promise<void>;
}

export const AuthSmsModal: React.FC<AuthSmsModalProps> = ({
  open,
  initialMode,
  onClose,
  bootstrap,
  lang,
  sessionToken,
  onSessionChange,
  onRefresh,
}) => {
  const [mode, setMode] = useState<'account' | 'register' | 'sms'>(initialMode);
  const [mobile, setMobile] = useState('+923001110001');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);

  // Registration fields (whole-village — zero neighbourhood/caste groups, includes Vote-Points proof factors)
  const [regName, setRegName] = useState('');
  const [regMobile, setRegMobile] = useState('+923009990021');
  const [regCnic, setRegCnic] = useState('');
  const [regDob, setRegDob] = useState('1996-05-15');
  const [regGender, setRegGender] = useState<'female' | 'male' | 'other'>('female');
  const [regHh, setRegHh] = useState('');
  const [regNewHh, setRegNewHh] = useState('');
  const [eduKey, setEduKey] = useState<'bachelor_plus' | 'intermediate' | 'matric' | 'class_1_5' | 'no_schooling'>('intermediate');
  const [workKey, setWorkKey] = useState<'senior_professional' | 'govt_job' | 'private_or_self_employed' | 'farmer_artisan' | 'unemployed_homemaker'>('farmer_artisan');
  const [expKey, setExpKey] = useState<'national_intl' | 'big_city' | 'district_town' | 'no_exposure'>('district_town');
  const [docLabel, setDocLabel] = useState('Original CNIC + School Certificate');
  const [smsMessages, setSmsMessages] = useState<Array<{ id: string; mobile_e164: string; message: string; category: string; created_at: string }>>([]);

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMode(initialMode);
    setErrorMsg(null);
    setStatusMsg(null);
  }, [initialMode, open]);

  const loadSms = async () => {
    try {
      const res = await apiFetch<{ messages: typeof smsMessages }>(
        '/sms-sandbox',
        {},
        bootstrap.activeSociety.id,
        sessionToken
      );
      setSmsMessages(res.messages);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (open && mode === 'sms') {
      loadSms();
    }
  }, [open, mode, bootstrap.activeSociety.id]);

  if (!open) return null;

  const handleSwitchPersona = async (memberId: string, fullName: string) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch<{ token: string }>(
        '/auth/demo-switch',
        {
          method: 'POST',
          body: JSON.stringify({ memberId }),
        },
        bootstrap.activeSociety.id
      );
      onSessionChange(res.token);
      await onRefresh();
      setStatusMsg(`Signed in as ${fullName}`);
      onClose();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSendLoginOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await apiFetch<{ demoCode: string }>(
        '/auth/otp/request',
        { method: 'POST', body: JSON.stringify({ mobile, purpose: 'login' }) },
        bootstrap.activeSociety.id
      );
      setOtpSent(true);
      setStatusMsg(`OTP dispatched (SMS Sandbox code: ${res.demoCode}).`);
      await loadSms();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyLoginOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch<{ token: string }>(
        '/auth/otp/verify',
        { method: 'POST', body: JSON.stringify({ mobile, purpose: 'login', code: otp }) },
        bootstrap.activeSociety.id
      );
      onSessionChange(res.token);
      await onRefresh();
      onClose();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await apiFetch<{
        id?: string;
        status: string;
        message?: string;
      }>(
        '/members',
        {
          method: 'POST',
          body: JSON.stringify({
            fullName: regName,
            mobile: regMobile,
            cnic: regCnic,
            dateOfBirth: regDob,
            gender: regGender,
            householdId: regHh || undefined,
            newHouseholdName: regNewHh || undefined,
            preferredLang: lang,
            educationKey: eduKey,
            workKey,
            exposureKey: expKey,
            docLabel,
            consent: true,
          }),
        },
        bootstrap.activeSociety.id
      );

      if (res.status === 'under_review') {
        setStatusMsg(res.message || 'Application received and placed under verification review.');
      } else {
        setStatusMsg(
          res.message ||
            'Application submitted (OTP confirmed). Awaiting Verification Officer check & second approver (AC-PTS-04: 0 Vote-Points until verified).'
        );
        setRegName('');
        setRegCnic('');
        await onRefresh();
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-xl overflow-hidden my-auto">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {bootstrap.activeSociety.name_en} — Identity, Roles &amp; SMS Sandbox
            </h2>
            <p className="text-xs text-slate-500">
              Mobile OTP sign-in, whole-village CNIC registration, or switch roles to verify v1.1 rules.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex border-b border-slate-200 bg-slate-50 px-6 pt-2 gap-2">
          {[
            { id: 'account' as const, label: 'Sign In / Switch Role', Icon: UserCheck },
            { id: 'register' as const, label: 'Join (CNIC + Points Proof)', Icon: UserPlus },
            { id: 'sms' as const, label: 'SMS Sandbox', Icon: MessageSquare },
          ].map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setMode(id);
                setErrorMsg(null);
              }}
              className={`inline-flex min-h-[40px] items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                mode === id
                  ? 'border-[#0F766E] text-[#0F766E]'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="p-6 max-h-[75vh] overflow-y-auto space-y-5">
          {errorMsg && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {errorMsg}
            </div>
          )}
          {statusMsg && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              {statusMsg}
            </div>
          )}

          {mode === 'account' && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-slate-900">Quick Stakeholder Role Switcher</h3>
                  {bootstrap.sessionUser && (
                    <button
                      type="button"
                      onClick={() => {
                        onSessionChange(null);
                        onRefresh();
                      }}
                      className="text-xs font-semibold text-red-600 hover:underline cursor-pointer"
                    >
                      Sign Out ({bootstrap.sessionUser.fullName})
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-500 mb-3">
                  Select any villager or governance officer in {bootstrap.activeSociety.name_en} to test Co-President contests, cross-team maker–checker, Vote-Points privacy, and two-person checks.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {bootstrap.personas.map((p) => {
                    const active = bootstrap.sessionUser?.id === p.id;
                    const roleText =
                      p.roles.length > 0
                        ? `${p.roles.join(', ')}${p.teamSide ? ` (${p.teamSide} team)` : ''}`
                        : p.isVerifiedVoter
                        ? 'Verified Voter'
                        : `${p.status} · ${p.identityStatus}`;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={busy}
                        onClick={() => handleSwitchPersona(p.id, p.fullName)}
                        className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer ${
                          active
                            ? 'border-[#0F766E] bg-[#0F766E]/5'
                            : 'border-slate-200 bg-white hover:border-slate-300'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900 truncate">{p.fullName}</div>
                          <div className="text-xs text-slate-500 truncate">{roleText}</div>
                        </div>
                        {active && <span className="text-xs font-bold text-[#0F766E] shrink-0">Active</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="border-t border-slate-200 pt-5">
                <h3 className="text-sm font-bold text-slate-900 mb-2 flex items-center gap-1.5">
                  <KeyRound className="h-4 w-4 text-[#0F766E]" />
                  Standard Mobile + OTP Login
                </h3>
                <form onSubmit={otpSent ? handleVerifyLoginOtp : handleSendLoginOtp} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <input
                    type="text"
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                    placeholder="+923001110001"
                    className="min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
                  />
                  {otpSent && (
                    <input
                      type="text"
                      value={otp}
                      onChange={(e) => setOtp(e.target.value)}
                      placeholder="6-digit OTP"
                      className="min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm font-mono-num"
                    />
                  )}
                  <button
                    type="submit"
                    disabled={busy}
                    className="min-h-[42px] rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 cursor-pointer"
                  >
                    {otpSent ? 'Verify & Sign In' : 'Send OTP'}
                  </button>
                </form>
              </div>
            </div>
          )}

          {mode === 'register' && (
            <form onSubmit={handleRegister} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name (as on CNIC)</label>
                  <input
                    required
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    placeholder="e.g. Meena Bheel"
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Mobile Number</label>
                  <input
                    required
                    value={regMobile}
                    onChange={(e) => setRegMobile(e.target.value)}
                    placeholder="+923001234567"
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">13-Digit CNIC (Encrypted + HMAC)</label>
                  <input
                    required
                    value={regCnic}
                    onChange={(e) => setRegCnic(e.target.value)}
                    placeholder="44301-1234567-9"
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Date of Birth (Min Age: 18)</label>
                  <input
                    required
                    type="date"
                    value={regDob}
                    onChange={(e) => setRegDob(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Gender (for Co-President Contest Rule)</label>
                  <select
                    value={regGender}
                    onChange={(e) => setRegGender(e.target.value as 'female' | 'male' | 'other')}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm bg-white"
                  >
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Existing Household (Optional)</label>
                  <select
                    value={regHh}
                    onChange={(e) => setRegHh(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm bg-white"
                  >
                    <option value="">Create New Household</option>
                    {bootstrap.households.map((hh) => (
                      <option key={hh.id} value={hh.id}>
                        {hh.name}
                      </option>
                    ))}
                  </select>
                </div>
                {!regHh && (
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-slate-700 mb-1">New Household Name</label>
                    <input
                      value={regNewHh}
                      onChange={(e) => setRegNewHh(e.target.value)}
                      placeholder="e.g. Bheel Household"
                      className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Vote-Points · Education Proof</label>
                  <select
                    value={eduKey}
                    onChange={(e) => setEduKey(e.target.value as typeof eduKey)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm bg-white"
                  >
                    <option value="bachelor_plus">Bachelor / Master / PhD (10 pts)</option>
                    <option value="intermediate">Intermediate / FA / FSc (6 pts)</option>
                    <option value="matric">Matric / Classes 6–10 (3 pts)</option>
                    <option value="class_1_5">Primary Classes 1–5 (1 pt)</option>
                    <option value="no_schooling">No Formal Schooling (OD Pending)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Vote-Points · Work / Craft</label>
                  <select
                    value={workKey}
                    onChange={(e) => setWorkKey(e.target.value as typeof workKey)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm bg-white"
                  >
                    <option value="senior_professional">Senior Specialist / Doctor / Engineer (4 pts)</option>
                    <option value="govt_job">Government Service (3 pts)</option>
                    <option value="private_or_self_employed">Private / Shop / Business (3 pts)</option>
                    <option value="farmer_artisan">Farming / Livestock / Craft (2 pts)</option>
                    <option value="unemployed_homemaker">Unemployed / Homemaker (1 pt)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Vote-Points · Wider Exposure</label>
                  <select
                    value={expKey}
                    onChange={(e) => setExpKey(e.target.value as typeof expKey)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm bg-white"
                  >
                    <option value="national_intl">National / International (4 pts)</option>
                    <option value="big_city">Large City Lived / Worked (2 pts)</option>
                    <option value="district_town">Nearby Town / District HQ (1 pt)</option>
                    <option value="no_exposure">Village Only (OD Pending)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Supporting Proof Label</label>
                  <input
                    value={docLabel}
                    onChange={(e) => setDocLabel(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm"
                  />
                </div>
              </div>

              <p className="text-xs text-slate-500">
                Whole-Village Privacy Guarantee: Zero neighbourhood/caste/religious fields. CNICs are AES-256 encrypted, duplicate CNICs return a neutral review response, and submitted Vote-Points factors remain at 0 pending points until verified (AC-PTS-04).
              </p>

              <button
                type="submit"
                disabled={busy}
                className="w-full min-h-[44px] rounded-lg bg-[#0F766E] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0D655E] cursor-pointer"
              >
                Submit Application for Two-Person Verification
              </button>
            </form>
          )}

          {mode === 'sms' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-600">
                  Live SMS gateway log for {bootstrap.activeSociety.name_en} (OTPs &amp; critical notices).
                </p>
                <button
                  type="button"
                  onClick={loadSms}
                  className="text-xs font-semibold text-[#0F766E] hover:underline cursor-pointer"
                >
                  Refresh
                </button>
              </div>
              {smsMessages.length === 0 ? (
                <p className="text-sm text-slate-500 py-4">No SMS messages sent yet in this village.</p>
              ) : (
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl">
                  {smsMessages.map((msg) => (
                    <div key={msg.id} className="p-3 text-sm">
                      <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                        <span className="font-mono-num font-semibold text-slate-700">{msg.mobile_e164}</span>
                        <span>{msg.category} · {new Date(msg.created_at).toLocaleTimeString()}</span>
                      </div>
                      <p className="text-slate-800">{msg.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

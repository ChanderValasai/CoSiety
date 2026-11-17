import React, { useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  RotateCcw,
  ShieldAlert,
  Wifi,
} from 'lucide-react';
import type { BootstrapData, LangCode, LedgerSummary } from '../types';
import { formatPkr, pickLang, t } from '../i18n/translations';
import { apiFetch } from '../utils/api';
import { ListenButton } from '../components/ListenButton';

interface MoneyViewProps {
  bootstrap: BootstrapData;
  ledgerSummary: LedgerSummary | null;
  lang: LangCode;
  sessionToken: string | null;
  onRefresh: () => Promise<void>;
  onOpenAuth: () => void;
}

export const MoneyView: React.FC<MoneyViewProps> = ({
  bootstrap,
  ledgerSummary,
  lang,
  sessionToken,
  onRefresh,
  onOpenAuth,
}) => {
  const [subTab, setSubTab] = useState<'vf' | 'packages' | 'recon' | 'cl'>('vf');
  const [vfEntries, setVfEntries] = useState<Array<{
    id: string;
    ref_no: string;
    entry_date: string;
    category: string;
    description: string;
    status: string;
    reverses_entry_id: string | null;
    project_id: string | null;
    evidence_ref: string | null;
    amountPkr: number;
    lines: Array<{ debit_pkr: number; credit_pkr: number; code: string; name: string }>;
  }>>([]);
  const [packagesData, setPackagesData] = useState<{
    activeLevyPkr: number;
    packages: Array<{ id: string; name_en: string; name_sd: string; name_ur: string; speed_label: string; price_pkr: number }>;
    purchases: Array<{ id: string; member_name: string; package_name: string; price_pkr: number; levy_pkr: number; total_pkr: number; status: string; followup_note: string | null; created_at: string }>;
  } | null>(null);
  const [reconData, setReconData] = useState<{
    salesReports: Array<{ id: string; period_label: string; version: number; status: string; paid_units: number; package_revenue_pkr: number; levy_due_pkr: number; submitted_at: string }>;
    transfers: Array<{ id: string; period_label: string; amount_expected_pkr: number; amount_declared_pkr: number; reference_no: string; state: string; declared_by: string; confirmed_by: string | null; dispute_reason: string | null }>;
    bankLines: Array<{ id: string; value_date: string; amount_pkr: number; narrative: string; bank_ref: string; matched: number }>;
  } | null>(null);
  const [clData, setClData] = useState<{
    contributors: Array<{
      id: string;
      display_name: string;
      payout_masked: string;
      totalContributedPkr: number;
      totalReturnedPkr: number;
      agreements: Array<{ version: string; return_cap_multiplier: number }>;
      distributions: Array<{ id: string; amount_pkr: number; status: string; payout_ref: string | null }>;
    }>;
    infraInvoices: Array<{ id: string; vendor_name: string; invoice_no: string; description: string; amount_pkr: number; document_ref: string }>;
    returnCalculations: Array<{ id: string; period_label: string; revenue_basis_pkr: number; pool_amount_pkr: number; status: string; prepared_by: string; approved_by: string | null }>;
  } | null>(null);

  // Action states
  const [levyInput, setLevyInput] = useState(50);
  const [srPeriod, setSrPeriod] = useState('2026-W47 (Nov 16–22)');
  const [srUnits, setSrUnits] = useState(310);
  const [srRev, setSrRev] = useState(345000);
  const [trRef, setTrRef] = useState(`IBFT-VT-${Math.floor(88800 + Math.random() * 100)}`);
  const [selectedBankLine, setSelectedBankLine] = useState('');

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sid = bootstrap.activeSociety.id;

  const loadTabDetails = async () => {
    try {
      const [vf, pkg, rec] = await Promise.all([
        apiFetch<{ entries: typeof vfEntries }>('/vf/entries', {}, sid, sessionToken),
        apiFetch<NonNullable<typeof packagesData>>('/packages', {}, sid, sessionToken),
        apiFetch<NonNullable<typeof reconData>>('/ops/reconciliation', {}, sid, sessionToken),
      ]);
      setVfEntries(vf.entries);
      setPackagesData(pkg);
      setReconData(rec);
      const firstUnmatched = rec.bankLines.find((b) => b.matched === 0);
      if (firstUnmatched && !selectedBankLine) setSelectedBankLine(firstUnmatched.id);

      if (bootstrap.sessionUser) {
        try {
          const cl = await apiFetch<NonNullable<typeof clData>>('/cl/contributors', {}, sid, sessionToken);
          setClData(cl);
        } catch {
          setClData(null);
        }
      } else {
        setClData(null);
      }
    } catch {
      // handled gracefully
    }
  };

  useEffect(() => {
    loadTabDetails();
  }, [sid, sessionToken, bootstrap.sessionUser?.id]);

  const handleBuyPackage = async (packageId: string, simulateStatus: 'paid' | 'failed') => {
    if (!bootstrap.sessionUser) {
      onOpenAuth();
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ pricePkr: number; levyPkr: number; totalPkr: number; status: string }>(
        '/purchases',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({ packageId, simulateStatus }),
        },
        sid,
        sessionToken
      );
      setMsg(
        `Purchase ${res.status.toUpperCase()}: Package ${formatPkr(res.pricePkr)} (VilloThar) + Levy ${formatPkr(res.levyPkr)} (Village Fund) = ${formatPkr(res.totalPkr)}.`
      );
      await Promise.all([loadTabDetails(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateLevy = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await apiFetch(
        '/vf/levy-config',
        {
          method: 'POST',
          body: JSON.stringify({ amountPkr: levyInput, resolutionCode: 'RES-2026-01' }),
        },
        sid,
        sessionToken
      );
      setMsg(`Levy updated to ${formatPkr(levyInput)} within approved constitutional cap.`);
      await Promise.all([loadTabDetails(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleReverseEntry = async (entryId: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ refNo: string }>(
        `/vf/entries/${entryId}/reverse`,
        { method: 'POST', body: JSON.stringify({ reason: 'Audit correction reversal' }) },
        sid,
        sessionToken
      );
      setMsg(`Append-only reversal entry ${res.refNo} posted (original record preserved).`);
      await Promise.all([loadTabDetails(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitSalesReport = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ levyDue: number; state: string }>(
        '/ops/sales-reports',
        {
          method: 'POST',
          body: JSON.stringify({
            periodLabel: srPeriod,
            paidUnits: srUnits,
            packageRevenuePkr: srRev,
            transferRef: trRef,
          }),
        },
        sid,
        sessionToken
      );
      setMsg(
        `VilloThar Sales Report & Transfer (${trRef}) submitted (${formatPkr(res.levyDue)} in state "${res.state}"). Excluded from VF bank balance until a Treasurer confirms bank match.`
      );
      await Promise.all([loadTabDetails(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmTransfer = async (transferId: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ vfEntryId: string }>(
        `/recon/transfers/${transferId}/confirm`,
        {
          method: 'POST',
          body: JSON.stringify(selectedBankLine ? { bankStatementLineId: selectedBankLine } : {}),
        },
        sid,
        sessionToken
      );
      setMsg(`Transfer confirmed against Sindh Bank statement! Posted to Village Fund (${res.vfEntryId}).`);
      await Promise.all([loadTabDetails(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDisputeTransfer = async (transferId: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await apiFetch(
        `/recon/transfers/${transferId}/dispute`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: 'Bank reference or levy calculation discrepancy flagged for VilloThar Ops' }),
        },
        sid,
        sessionToken
      );
      setMsg('Transfer marked as Disputed for VilloThar Ops resolution.');
      await Promise.all([loadTabDetails(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCalculateReturns = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ poolPkr: number }>(
        '/cl/return-calculations',
        { method: 'POST', body: JSON.stringify({ periodLabel: '2026-11' }) },
        sid,
        sessionToken
      );
      setMsg(`Contributor return pool (${formatPkr(res.poolPkr)}) calculated in draft. Second finance approver required.`);
      await loadTabDetails();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleApproveReturns = async (calcId: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await apiFetch(
        `/cl/return-calculations/${calcId}/approve`,
        { method: 'POST', body: '{}' },
        sid,
        sessionToken
      );
      setMsg('Contributor returns approved by checker and distributed.');
      await Promise.all([loadTabDetails(), onRefresh()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">
              Three-Stream Public Ledger &amp; Reconciliation
            </h1>
            <p className="mt-1 text-sm text-slate-600">{t(lang, 'streamSeparationBanner')}</p>
          </div>
          {ledgerSummary && (
            <ListenButton
              text={`Village Fund confirmed bank balance is ${ledgerSummary.villageFund.bankBalancePkr} rupees. ${ledgerSummary.villageFund.transfersInFlightPkr} rupees are in transit and not counted in balance.`}
              lang={lang}
            />
          )}
        </div>

        <div className="mt-5 flex flex-wrap gap-1.5 rounded-xl bg-slate-100 p-1">
          {[
            { id: 'vf' as const, label: '1. Village Fund Ledger' },
            { id: 'packages' as const, label: '2. Packages & Levy' },
            { id: 'recon' as const, label: '3. VilloThar Ops & Bank Match' },
            { id: 'cl' as const, label: '4. Contributors (CL)' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setSubTab(tab.id);
                setErr(null);
                setMsg(null);
              }}
              className={`min-h-[40px] flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                subTab === tab.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{err}</div>}
      {msg && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{msg}</div>}

      {/* SUB-TAB 1: VILLAGE FUND PUBLIC LEDGER */}
      {subTab === 'vf' && ledgerSummary && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-[#0F766E]/30 bg-white p-5">
              <div className="text-xs font-semibold text-slate-500">Confirmed Bank Balance</div>
              <div className="mt-1 text-2xl font-extrabold text-slate-900 font-mono-num">
                {formatPkr(ledgerSummary.villageFund.bankBalancePkr)}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold text-slate-500">Total Levy Received</div>
              <div className="mt-1 text-2xl font-bold text-emerald-700 font-mono-num">
                {formatPkr(ledgerSummary.villageFund.totalReceivedPkr)}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold text-slate-500">Approved Project Spend</div>
              <div className="mt-1 text-2xl font-bold text-slate-900 font-mono-num">
                {formatPkr(ledgerSummary.villageFund.totalSpentPkr)}
              </div>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
              <div className="text-xs font-semibold text-amber-800">Sent / Awaiting Match (Not in Balance)</div>
              <div className="mt-1 text-2xl font-bold text-amber-800 font-mono-num">
                {formatPkr(ledgerSummary.villageFund.transfersInFlightPkr)}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Append-Only Village Fund Entries</h2>
                <p className="text-xs text-slate-500">
                  SQLite triggers forbid UPDATE/DELETE (AC-FIN-02). Reversals require a second finance officer (Maker–Checker).
                </p>
              </div>
              <form onSubmit={handleUpdateLevy} className="flex items-center gap-2">
                <label className="text-xs font-semibold text-slate-600">
                  Levy (Cap {formatPkr(ledgerSummary.villageFund.levyCapPkr)}):
                </label>
                <input
                  type="number"
                  value={levyInput}
                  onChange={(e) => setLevyInput(Number(e.target.value))}
                  className="w-20 min-h-[38px] rounded-lg border border-slate-300 px-2 text-xs font-mono-num"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
                >
                  Update Levy
                </button>
              </form>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2.5 pr-3">Date</th>
                    <th className="py-2.5 pr-3">Ref No</th>
                    <th className="py-2.5 pr-3">Category &amp; Description</th>
                    <th className="py-2.5 pr-3 text-right">Bank In</th>
                    <th className="py-2.5 pr-3 text-right">Bank Out</th>
                    <th className="py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {vfEntries.map((e) => {
                    const bankLines = e.lines.filter((l) => l.code === '1100');
                    const cashIn = bankLines.reduce((acc, l) => acc + l.debit_pkr, 0);
                    const cashOut = bankLines.reduce((acc, l) => acc + l.credit_pkr, 0);
                    return (
                      <tr key={e.id} className="hover:bg-slate-50/60">
                        <td className="py-3 pr-3 font-mono-num text-slate-600 whitespace-nowrap">{e.entry_date}</td>
                        <td className="py-3 pr-3 font-mono-num font-semibold text-slate-900 whitespace-nowrap">{e.ref_no}</td>
                        <td className="py-3 pr-3">
                          <div className="font-medium text-slate-900">{e.description}</div>
                          <div className="text-slate-500">
                            {e.category} · Total {formatPkr(e.amountPkr)}{' '}
                            {e.evidence_ref ? `· Evidence: ${e.evidence_ref}` : ''}{' '}
                            {e.reverses_entry_id ? '· Reversal Entry' : ''}
                          </div>
                        </td>
                        <td className="py-3 pr-3 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                          {cashIn > 0 ? `+${formatPkr(cashIn)}` : '—'}
                        </td>
                        <td className="py-3 pr-3 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                          {cashOut > 0 ? `-${formatPkr(cashOut)}` : '—'}
                        </td>
                        <td className="py-3 text-right whitespace-nowrap">
                          {!e.reverses_entry_id && (
                            <button
                              type="button"
                              onClick={() => handleReverseEntry(e.id)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                            >
                              <RotateCcw className="h-3 w-3" /> Reverse
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: PACKAGES & INDIVIDUAL LEVY */}
      {subTab === 'packages' && packagesData && (
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="text-lg font-bold text-slate-900">Single-Price Village Internet Packages</h2>
            <p className="mt-1 text-xs text-slate-600">
              Every resident pays the same package price. The Village Fund levy ({formatPkr(packagesData.activeLevyPkr)}) is charged per individual package and shown separately (AC-FIN-05: failed/pending excluded).
            </p>

            <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
              {packagesData.packages.map((p) => {
                const levy = packagesData.activeLevyPkr;
                const total = p.price_pkr + levy;
                return (
                  <div key={p.id} className="flex flex-col justify-between rounded-xl border border-slate-200 p-5">
                    <div>
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span className="font-semibold text-[#0F766E]">{p.speed_label}</span>
                        <Wifi className="h-4 w-4 text-slate-400" />
                      </div>
                      <h3 className="mt-2 text-lg font-bold text-slate-900">
                        {pickLang(lang, p.name_en, p.name_sd, p.name_ur)}
                      </h3>

                      <div className="mt-4 space-y-1.5 border-t border-slate-100 pt-3 text-sm">
                        <div className="flex justify-between text-slate-600">
                          <span>Package Price (VilloThar)</span>
                          <span className="font-mono-num font-semibold text-slate-900">{formatPkr(p.price_pkr)}</span>
                        </div>
                        <div className="flex justify-between text-[#0F766E]">
                          <span>Village Fund Levy</span>
                          <span className="font-mono-num font-semibold">{formatPkr(levy)}</span>
                        </div>
                        <div className="flex justify-between border-t border-slate-100 pt-1.5 font-bold text-slate-900">
                          <span>Total Payable</span>
                          <span className="font-mono-num">{formatPkr(total)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="mt-5 flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleBuyPackage(p.id, 'paid')}
                        className="min-h-[44px] flex-1 rounded-lg bg-[#0F766E] px-3 text-xs font-semibold text-white hover:bg-[#0D655E] cursor-pointer"
                      >
                        Record Paid Purchase
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleBuyPackage(p.id, 'failed')}
                        className="min-h-[44px] rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
                      >
                        Test Failed
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <h3 className="text-base font-bold text-slate-900 mb-3">
              Recent Purchases &amp; Failed / Pending Ageing
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">Subscriber</th>
                    <th className="py-2 pr-3">Package</th>
                    <th className="py-2 pr-3 text-right">Price</th>
                    <th className="py-2 pr-3 text-right">Levy</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2">Follow-Up</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {packagesData.purchases.map((pur) => (
                    <tr key={pur.id}>
                      <td className="py-2.5 pr-3 font-medium text-slate-900">{pur.member_name}</td>
                      <td className="py-2.5 pr-3 text-slate-600">{pur.package_name}</td>
                      <td className="py-2.5 pr-3 text-right font-mono-num">{formatPkr(pur.price_pkr)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono-num text-[#0F766E]">{formatPkr(pur.levy_pkr)}</td>
                      <td className="py-2.5 pr-3">
                        <span className={`font-semibold uppercase ${pur.status === 'paid' ? 'text-emerald-700' : pur.status === 'failed' ? 'text-red-700' : 'text-amber-700'}`}>
                          {pur.status}
                        </span>
                      </td>
                      <td className="py-2.5 text-slate-500">{pur.followup_note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 3: VILLOTHAR OPS & THREE-WAY RECONCILIATION */}
      {subTab === 'recon' && reconData && (
        <div className="space-y-6">
          <form onSubmit={handleSubmitSalesReport} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-900">
              1. VilloThar Ops: Publish Sales Report &amp; Declare Levy Transfer (State: Sent)
            </h2>
            <p className="text-xs text-slate-500">
              Sign in as <strong>Tariq Solangi (villothar_ops)</strong> to submit a period report and bank transfer declaration. Funds remain excluded from confirmed VF balance until a Treasurer confirms bank statement match (AC-FIN-01).
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input
                value={srPeriod}
                onChange={(e) => setSrPeriod(e.target.value)}
                placeholder="Period Label"
                className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-xs"
              />
              <input
                type="number"
                value={srUnits}
                onChange={(e) => setSrUnits(Number(e.target.value))}
                placeholder="Paid Units"
                className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-xs font-mono-num"
              />
              <input
                type="number"
                value={srRev}
                onChange={(e) => setSrRev(Number(e.target.value))}
                placeholder="Revenue (PKR)"
                className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-xs font-mono-num"
              />
              <input
                value={trRef}
                onChange={(e) => setTrRef(e.target.value)}
                placeholder="IBFT Transfer Ref"
                className="min-h-[40px] rounded-lg border border-slate-300 px-3 text-xs font-mono-num"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[42px] rounded-lg bg-amber-700 px-4 text-xs font-semibold text-white hover:bg-amber-800 cursor-pointer"
            >
              Publish Sales Report &amp; Declare Sent Transfer
            </button>
          </form>

          {/* Treasurer Bank Reconciliation Board */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <ArrowLeftRight className="h-4 w-4 text-[#0F766E]" />
                  2. Treasurer Bank Statement Matching Board
                </h3>
                <p className="text-xs text-slate-500">
                  Sign in as <strong>Bilawal Nohrio (treasurer · woman team)</strong> or <strong>Parveen Junejo (treasurer · man team)</strong> or either Co-President to confirm sent transfers against Sindh Bank IBFT lines.
                </p>
              </div>
              <select
                value={selectedBankLine}
                onChange={(e) => setSelectedBankLine(e.target.value)}
                className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-3 text-xs"
              >
                <option value="">Auto-match by Transfer Ref (or pick line)...</option>
                {reconData.bankLines
                  .filter((b) => b.matched === 0)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.value_date} · {b.bank_ref} · {formatPkr(b.amount_pkr)}
                    </option>
                  ))}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">Period</th>
                    <th className="py-2 pr-3">Bank Ref</th>
                    <th className="py-2 pr-3 text-right">Expected</th>
                    <th className="py-2 pr-3 text-right">Declared</th>
                    <th className="py-2 pr-3">State</th>
                    <th className="py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reconData.transfers.map((tr) => (
                    <tr key={tr.id}>
                      <td className="py-2.5 pr-3 font-medium text-slate-900">{tr.period_label}</td>
                      <td className="py-2.5 pr-3 font-mono-num text-slate-600">{tr.reference_no}</td>
                      <td className="py-2.5 pr-3 text-right font-mono-num">{formatPkr(tr.amount_expected_pkr)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono-num font-semibold">{formatPkr(tr.amount_declared_pkr)}</td>
                      <td className="py-2.5 pr-3">
                        <span className={`font-bold uppercase ${tr.state === 'confirmed' ? 'text-emerald-700' : tr.state === 'disputed' ? 'text-red-700' : 'text-amber-700'}`}>
                          {tr.state}
                        </span>
                        {tr.dispute_reason && <div className="text-[11px] text-red-600">{tr.dispute_reason}</div>}
                      </td>
                      <td className="py-2.5 text-right space-x-2 whitespace-nowrap">
                        {tr.state === 'sent' ? (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleConfirmTransfer(tr.id)}
                              className="min-h-[34px] rounded-lg bg-[#0F766E] px-3 text-xs font-semibold text-white cursor-pointer"
                            >
                              Confirm Match
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleDisputeTransfer(tr.id)}
                              className="min-h-[34px] rounded-lg border border-red-200 px-2.5 text-xs font-semibold text-red-700 cursor-pointer"
                            >
                              Dispute
                            </button>
                          </>
                        ) : (
                          <span className="text-slate-400">{tr.state === 'confirmed' ? 'Matched' : 'Disputed'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 4: CONTRIBUTOR LEDGER (AGGREGATE PUBLIC VS PRIVATE AUTHORIZED) */}
      {subTab === 'cl' && ledgerSummary && (
        <div className="space-y-6">
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5 flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-indigo-700 shrink-0 mt-0.5" />
            <div className="text-sm text-indigo-950">
              <strong>Constitutional Rule (AC-CON-01):</strong> Infrastructure contributors hold no extra voting rights or seats. Public visitors see village-wide totals only; individual agreements and return payouts require authentication as a Treasurer, Co-President, Auditor, or Contributor.
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold text-slate-500">Contributors</div>
              <div className="mt-1 text-2xl font-bold font-mono-num">{ledgerSummary.contributorLedgerAggregate.contributorCount}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold text-slate-500">Total Capital Pooled</div>
              <div className="mt-1 text-2xl font-bold font-mono-num">{formatPkr(ledgerSummary.contributorLedgerAggregate.totalCapitalPkr)}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold text-slate-500">Equipment Invoices Paid</div>
              <div className="mt-1 text-2xl font-bold font-mono-num">{formatPkr(ledgerSummary.contributorLedgerAggregate.totalInfraPaidPkr)}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold text-slate-500">CL Bank Balance</div>
              <div className="mt-1 text-2xl font-bold font-mono-num text-indigo-700">{formatPkr(ledgerSummary.contributorLedgerAggregate.clBankBalancePkr)}</div>
            </div>
          </div>

          {!bootstrap.sessionUser || !clData ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="text-sm text-slate-600">
                Individual Contributor Ledger statements are strictly private (AC-CON-01). Sign in as <strong>Treasurer</strong>, <strong>Co-President</strong>, or <strong>Auditor</strong> to inspect statements or calculate returns.
              </div>
              <button
                type="button"
                onClick={onOpenAuth}
                className="min-h-[42px] rounded-lg bg-[#0F766E] px-4 text-xs font-semibold text-white shrink-0 cursor-pointer"
              >
                Sign In to Inspect
              </button>
            </div>
          ) : (
            <>
              <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-bold text-slate-900">Authorized Contributor Statements &amp; Agreements</h3>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleCalculateReturns}
                    className="min-h-[40px] rounded-lg border border-indigo-300 bg-indigo-50 px-3 text-xs font-semibold text-indigo-900 hover:bg-indigo-100 cursor-pointer"
                  >
                    Finance Maker: Calculate Period Returns
                  </button>
                </div>
                {clData.contributors.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Your current account does not own a contributor agreement or hold finance/audit privileges (AC-CON-01).
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {clData.contributors.map((c) => (
                      <div key={c.id} className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div>
                          <div className="text-sm font-bold text-slate-900">{c.display_name}</div>
                          <div className="text-xs text-slate-500 font-mono-num">
                            Payout Account: {c.payout_masked} · Agreement {c.agreements[0]?.version} (Cap {c.agreements[0]?.return_cap_multiplier}x)
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-bold font-mono-num text-slate-900">
                            Capital: {formatPkr(c.totalContributedPkr)}
                          </div>
                          <div className="text-xs text-slate-500 font-mono-num">
                            Returns Paid: {formatPkr(c.totalReturnedPkr)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="rounded-2xl border border-slate-200 bg-white p-6">
                  <h3 className="text-base font-bold text-slate-900 mb-3">Infrastructure Invoices Paid to VilloThar</h3>
                  {clData.infraInvoices.map((inv) => (
                    <div key={inv.id} className="border-t border-slate-100 py-3 first:border-t-0 text-sm">
                      <div className="flex justify-between font-semibold text-slate-900">
                        <span>{inv.invoice_no} · {inv.vendor_name}</span>
                        <span className="font-mono-num">{formatPkr(inv.amount_pkr)}</span>
                      </div>
                      <p className="text-xs text-slate-600 mt-1">{inv.description}</p>
                    </div>
                  ))}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-6">
                  <h3 className="text-base font-bold text-slate-900 mb-3">Contributor Return Calculations (Maker–Checker)</h3>
                  {clData.returnCalculations.length === 0 ? (
                    <p className="text-sm text-slate-500">No return calculations generated yet.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {clData.returnCalculations.map((rc) => (
                        <div key={rc.id} className="py-3 flex items-center justify-between gap-3 text-sm">
                          <div>
                            <div className="font-semibold text-slate-900">
                              Period {rc.period_label} · Pool {formatPkr(rc.pool_amount_pkr)}
                            </div>
                            <div className="text-xs text-slate-500">
                              Revenue basis: {formatPkr(rc.revenue_basis_pkr)} · Status: {rc.status}
                            </div>
                          </div>
                          {rc.status === 'draft' && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleApproveReturns(rc.id)}
                              className="min-h-[38px] rounded-lg bg-[#0F766E] px-3 text-xs font-semibold text-white cursor-pointer"
                            >
                              Checker: Approve &amp; Distribute
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

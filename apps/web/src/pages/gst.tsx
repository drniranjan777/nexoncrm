import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Info } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, inr, toDateInput } from '@/lib/utils';
import { Card, CardHeader, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, Stat, Table, TBody, TD, TH, THead, Tabs, TabsContent, TabsList, TabsTrigger, Button } from '@/components/ui';

type Row = Record<string, string | number | null>;
interface Gst {
  month: string; gstin: string | null; legalName: string;
  summary: Record<'b2b' | 'b2cl' | 'b2cs' | 'nil' | 'cdnr', { count: number; taxable: number; igst: number; cgst: number; sgst: number }>;
  gstr1: { b2b: Row[]; b2cl: Row[]; b2cs: Row[]; cdnr: Row[]; hsn: Row[] };
  gstr3b: { outwardTaxable: { taxable: number; igst: number; cgst: number; sgst: number }; nilExempt: { taxable: number }; interStateUnregistered: Row[] };
}

const SECTIONS: { key: keyof Gst['gstr1']; label: string; cols: [string, string, ('money' | 'date')?][] }[] = [
  { key: 'b2b', label: 'B2B Invoices (4A)', cols: [['gstin', 'GSTIN'], ['customer', 'Receiver'], ['number', 'Invoice#'], ['date', 'Date', 'date'], ['pos', 'Place of supply'], ['value', 'Invoice value', 'money'], ['taxable', 'Taxable', 'money'], ['igst', 'IGST', 'money'], ['cgst', 'CGST', 'money'], ['sgst', 'SGST', 'money']] },
  { key: 'b2cl', label: 'B2C Large (5A)', cols: [['customer', 'Customer'], ['number', 'Invoice#'], ['date', 'Date', 'date'], ['pos', 'Place of supply'], ['value', 'Invoice value', 'money'], ['taxable', 'Taxable', 'money'], ['igst', 'IGST', 'money']] },
  { key: 'b2cs', label: 'B2C Small (7)', cols: [['pos', 'Place of supply'], ['supplyType', 'Supply type'], ['taxable', 'Taxable', 'money'], ['igst', 'IGST', 'money'], ['cgst', 'CGST', 'money'], ['sgst', 'SGST', 'money']] },
  { key: 'cdnr', label: 'Credit Notes (9B)', cols: [['gstin', 'GSTIN'], ['customer', 'Receiver'], ['number', 'Note#'], ['date', 'Date', 'date'], ['invoice', 'Against invoice'], ['taxable', 'Taxable', 'money'], ['igst', 'IGST', 'money'], ['cgst', 'CGST', 'money'], ['sgst', 'SGST', 'money']] },
  { key: 'hsn', label: 'HSN/SAC Summary (12)', cols: [['hsn', 'HSN/SAC'], ['rate', 'Rate %'], ['quantity', 'Quantity'], ['taxable', 'Taxable', 'money'], ['igst', 'IGST', 'money'], ['cgst', 'CGST', 'money'], ['sgst', 'SGST', 'money']] },
];

export function GstFilingPage() {
  const [month, setMonth] = useState(toDateInput(new Date()).slice(0, 7));
  const q = useQuery({ queryKey: ['gst', month], queryFn: () => api.get<Gst>('/gst/returns', { month }) });
  const g = q.data;
  return (
    <div>
      <PageHeader title="GST Filing" description="Return-ready summaries of your outward supplies. Export each section and file through the GST portal or your GSP."
        actions={<Input type="month" className="w-44" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Return period" />} />
      <div className="mb-4 flex gap-3 rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-900"><Info className="mt-0.5 size-4 shrink-0" /><span>This app prepares the figures but does not file returns with GSTN directly. Review with your accountant before filing. Purchases and input tax credit are not tracked here.</span></div>
      {q.isLoading ? <Card><LoadingBlock /></Card> : q.error ? <Card><ErrorState error={q.error} /></Card> : g && (
        <>
          {!g.gstin && <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">Your company GSTIN is not set. <Link to="/settings/company" className="font-medium underline">Add it in Company Profile.</Link></div>}
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Taxable outward supplies" value={inr(g.gstr3b.outwardTaxable.taxable)} hint="Net of credit notes" />
            <Stat label="IGST" value={inr(g.gstr3b.outwardTaxable.igst)} />
            <Stat label="CGST" value={inr(g.gstr3b.outwardTaxable.cgst)} />
            <Stat label="SGST / UTGST" value={inr(g.gstr3b.outwardTaxable.sgst)} />
          </div>
          <Tabs defaultValue="gstr1">
            <TabsList><TabsTrigger value="gstr1">GSTR-1</TabsTrigger><TabsTrigger value="gstr3b">GSTR-3B</TabsTrigger></TabsList>
            <TabsContent value="gstr1" className="space-y-6">
              {SECTIONS.map((s) => {
                const rows = g.gstr1[s.key];
                return (
                  <Card key={s.key}>
                    <CardHeader title={s.label} description={`${rows.length} row${rows.length === 1 ? '' : 's'}`}
                      actions={rows.length > 0 && <Button size="sm" variant="secondary" onClick={() => api.download('/gst/returns', `gstr1-${s.key}-${month}.csv`, { month, section: s.key, format: 'csv' }).catch((e) => toast.error(errorMessage(e)))}><Download /> CSV</Button>} />
                    {!rows.length ? <EmptyState title="Nothing to report" /> : (
                      <Table><THead><tr>{s.cols.map(([, l, t]) => <TH key={l} className={t === 'money' ? 'text-right' : ''}>{l}</TH>)}</tr></THead><TBody>
                        {rows.map((r, i) => <tr key={i}>{s.cols.map(([k, , t]) => <TD key={k} className={t === 'money' ? 'text-right tabular-nums' : ''}>{t === 'money' ? inr(r[k]) : t === 'date' ? fmtDate(r[k] as string) : r[k] ?? '—'}</TD>)}</tr>)}
                      </TBody></Table>
                    )}
                  </Card>
                );
              })}
            </TabsContent>
            <TabsContent value="gstr3b" className="space-y-6">
              <Card>
                <CardHeader title="3.1 Details of outward supplies and inward supplies liable to reverse charge" />
                <Table><THead><tr><TH>Nature of supplies</TH><TH className="text-right">Total taxable value</TH><TH className="text-right">Integrated tax</TH><TH className="text-right">Central tax</TH><TH className="text-right">State/UT tax</TH></tr></THead><TBody>
                  <tr><TD>(a) Outward taxable supplies (other than zero rated, nil rated and exempted)</TD><TD className="text-right tabular-nums">{inr(g.gstr3b.outwardTaxable.taxable)}</TD><TD className="text-right tabular-nums">{inr(g.gstr3b.outwardTaxable.igst)}</TD><TD className="text-right tabular-nums">{inr(g.gstr3b.outwardTaxable.cgst)}</TD><TD className="text-right tabular-nums">{inr(g.gstr3b.outwardTaxable.sgst)}</TD></tr>
                  <tr><TD>(b) Outward taxable supplies (zero rated)</TD><TD className="text-right tabular-nums">{inr(0)}</TD><TD className="text-right">—</TD><TD className="text-right">—</TD><TD className="text-right">—</TD></tr>
                  <tr><TD>(c) Other outward supplies (nil rated, exempted)</TD><TD className="text-right tabular-nums">{inr(g.gstr3b.nilExempt.taxable)}</TD><TD className="text-right">—</TD><TD className="text-right">—</TD><TD className="text-right">—</TD></tr>
                </TBody></Table>
              </Card>
              <Card>
                <CardHeader title="3.2 Inter-state supplies made to unregistered persons" />
                {!g.gstr3b.interStateUnregistered.length ? <EmptyState title="None this period" /> : (
                  <Table><THead><tr><TH>Place of supply</TH><TH className="text-right">Taxable value</TH><TH className="text-right">Integrated tax</TH></tr></THead><TBody>
                    {g.gstr3b.interStateUnregistered.map((r, i) => <tr key={i}><TD>{r.pos}</TD><TD className="text-right tabular-nums">{inr(r.taxable)}</TD><TD className="text-right tabular-nums">{inr(r.igst)}</TD></tr>)}
                  </TBody></Table>
                )}
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

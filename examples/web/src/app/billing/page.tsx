'use client';

import { useLiveQuery } from '@dltech/pgbase/react';
import { useMemo } from 'react';
import { pgbase } from '../../pgbase/client';

export default function BillingPage() {
  const invoices = useLiveQuery(pgbase.Invoice);

  const ordered = useMemo(
    () => [...invoices].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime()),
    [invoices],
  );

  return (
    <main>
      <h1>Invoices</h1>
      <p className="lede">
        Numeric fidelity, end to end. <code>amount</code> is a <code>Decimal(18,4)</code> and{' '}
        <code>externalRef</code> an <code>int8</code>; both are wider than a JS number holds
        exactly, so they arrive as a string and a <code>bigint</code> rather than being silently
        rounded on the way through.
      </p>

      <table>
        <thead>
          <tr>
            <th>Issued</th>
            <th className="num">Amount</th>
            <th className="num">External ref</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((invoice) => (
            <tr key={invoice.id}>
              <td>{invoice.issuedAt.toLocaleDateString()}</td>
              <td className="num">{invoice.amount}</td>
              <td className="num">{invoice.externalRef.toString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="lede" style={{ marginTop: '1rem' }}>
        Total <strong>{totalOf(ordered.map((i) => i.amount))}</strong>, summed as integer units of
        the column&apos;s own scale. Nothing here is ever converted to a float.
      </p>
    </main>
  );
}

const SCALE = 4; // matches Decimal(18, 4)

function totalOf(amounts: readonly string[]): string {
  let units = 0n;
  for (const amount of amounts) {
    const [whole = '0', fraction = ''] = amount.split('.');
    units += BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0'));
  }
  const divisor = 10n ** BigInt(SCALE);
  return `${units / divisor}.${String(units % divisor).padStart(SCALE, '0')}`;
}

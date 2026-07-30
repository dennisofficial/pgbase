'use client';

// Both subpaths are still stubs (`export {}`) — namespace imports only, to prove the client-side
// resolution works ahead of there being real hooks/client exports to call.
import * as PgbaseClient from '@workspace/pgbase/client';
import * as PgbaseReact from '@workspace/pgbase/react';
import { useAppSelector } from '../redux/hooks';
import { selectListItems } from '../redux/list/list-slice';

void PgbaseClient;
void PgbaseReact;

export default function Page() {
  const items = useAppSelector(selectListItems);

  return (
    <main>
      <h1>pgbase example</h1>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}

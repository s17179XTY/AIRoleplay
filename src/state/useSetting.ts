import { useEffect, useState } from 'react';
import { db } from '../core/storage/db';

export function useSetting(key: string, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    void (async () => {
      const row = await db.settings.get(key);
      if (row) setValue(row.value);
    })();
  }, [key]);
  const update = (v: string) => {
    setValue(v);
    void db.settings.put({ key, value: v });
  };
  return [value, update];
}

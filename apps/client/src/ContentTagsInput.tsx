import { useEffect, useRef, useState } from 'react';

export function ContentTagsInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [raw, setRaw] = useState(value.join(', ')), known = useRef(JSON.stringify(value));
  useEffect(() => {
    const encoded = JSON.stringify(value);
    if (encoded !== known.current) { known.current = encoded; setRaw(value.join(', ')); }
  }, [value]);
  return <input maxLength={1000} value={raw} placeholder="Separate tags with commas" onChange={event => {
    setRaw(event.target.value);
    const tags = [...new Set(event.target.value.split(',').map(tag => tag.trim()).filter(Boolean))].slice(0, 20);
    known.current = JSON.stringify(tags);
    onChange(tags);
  }}/>;
}

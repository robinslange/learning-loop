export function parseXMLTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

export function parseXMLTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'gs');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

import { parse } from 'tldts';

export function getCookieUrlFromDomain(domain: string) {
  // allowPrivateDomains: treat PSL private suffixes (e.g. *.ts.net for Tailscale
  // MagicDNS) as public suffixes, otherwise the cookie would be scoped to
  // ".ts.net" and rejected by browsers.
  const url = parse(domain, { allowPrivateDomains: true });
  return url.domain! ? '.' + url.domain! : url.hostname!;
}

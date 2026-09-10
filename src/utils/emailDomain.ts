const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "mail.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
  "gmx.com",
  "yandex.com",
  "msn.com",
]);

export const extractEmailDomain = (email: string): string => {
  return email.trim().toLowerCase().split("@")[1] ?? "";
};

export const isPublicEmailDomain = (email: string): boolean => {
  const domain = extractEmailDomain(email);
  return domain ? PUBLIC_EMAIL_DOMAINS.has(domain) : true;
};

export const isCorporateEmail = (email: string): boolean => {
  return validateEmailFormat(email) && !isPublicEmailDomain(email);
};

const validateEmailFormat = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

export const assertMatchingWorkEmailDomain = (companyEmail: string, workEmail: string): void => {
  const companyDomain = extractEmailDomain(companyEmail);
  const workDomain = extractEmailDomain(workEmail);

  if (!companyDomain || !workDomain) {
    throw new Error("Invalid email domain");
  }

  if (companyDomain !== workDomain) {
    throw new Error(
      `Work email domain (@${workDomain}) must match the company domain (@${companyDomain})`
    );
  }
};

export const extractWebsiteDomain = (url: string): string => {
  try {
    const normalized = url.trim();
    if (!normalized) return "";
    const withProtocol = /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
    const hostname = new URL(withProtocol).hostname.toLowerCase();
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return "";
  }
};

export const emailDomainMatchesWebsite = (email: string, website: string): boolean => {
  const emailDomain = extractEmailDomain(email);
  const websiteDomain = extractWebsiteDomain(website);
  return !!emailDomain && !!websiteDomain && emailDomain === websiteDomain;
};

/** Validates @domain.tld shape (at least one dot after @). */
export const parseCompanyDomain = (input: string): string => {
  const trimmed = input.trim();
  if (!/^@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error("Domain must start with @ and include a dot (e.g. @acme.com)");
  }
  return trimmed;
};

/** Strips leading @ and lowercases, e.g. @Acme.com → acme.com */
export const normalizeCompanyDomain = (input: string): string => {
  const parsed = parseCompanyDomain(input.startsWith("@") ? input : `@${input}`);
  return parsed.slice(1).toLowerCase();
};

export const formatCompanyDomain = (domain: string): string =>
  domain.startsWith("@") ? domain : `@${domain}`;

export const emailMatchesCompanyDomain = (email: string, companyDomain: string): boolean => {
  const normalized = companyDomain.startsWith("@")
    ? companyDomain.slice(1).toLowerCase()
    : companyDomain.toLowerCase();
  return extractEmailDomain(email) === normalized;
};

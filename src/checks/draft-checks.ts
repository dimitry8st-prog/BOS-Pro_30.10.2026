import {
  FIXTURE_LIMITATION,
  LIMITS,
  REACHABILITY_IS_NOT_TRUTH,
  RULES_VERSION,
} from "../contract/constants.js";
import { codePointLength } from "../contract/hash.js";
import { isHttpUrl } from "../contract/validate.js";
import type {
  ClaimLink,
  PrepareDraftInput,
  ProviderDraft,
  UrlCheck,
  UrlCheckStatus,
  VerificationCheck,
  VerificationReport,
} from "../contract/types.js";

const MEASURED_SAVINGS = /измеренн\p{L}*\s+эконом|\d+\s*%/iu;

export function limitationsForUrlStatus(status: UrlCheckStatus): string {
  if (status === "not_checked") {
    return `${REACHABILITY_IS_NOT_TRUTH} Адрес не запрашивался: учебный источник fixture не считается живой проверкой URL.`;
  }
  return REACHABILITY_IS_NOT_TRUTH;
}

export function verifyDraft(input: PrepareDraftInput, draft: ProviderDraft): VerificationReport {
  const bodyLength = codePointLength(draft.body);
  const lengthCheck: VerificationCheck = {
    code: "body_length",
    executed: true,
    pass: bodyLength <= input.criteria.max_body_chars,
    detail: `Длина основного текста ${bodyLength} при максимуме ${input.criteria.max_body_chars}.`,
  };

  const listedIds = new Set(draft.sources.map((source) => source.source_id));
  const expectedIds = input.sources.map((source) => source.source_id);
  const separate = expectedIds.every((id) => listedIds.has(id)) && draft.sources.length === input.sources.length;
  const sourcesSeparate: VerificationCheck = {
    code: "sources_separate",
    executed: true,
    pass: separate,
    detail: separate
      ? "Источники перечислены отдельно от основного текста."
      : "Отдельный список источников не совпадает с разрешёнными источниками входа.",
  };

  const syntaxPass = input.sources.every((source) => isHttpUrl(source.url)) && draft.sources.every((source) => isHttpUrl(source.url));
  const urlSyntax: VerificationCheck = {
    code: "source_url_syntax",
    executed: true,
    pass: syntaxPass,
    detail: syntaxPass
      ? "Синтаксис URL проверен. Сетевой запрос не выполнялся."
      : "Хотя бы один URL не проходит синтаксическую проверку http(s).",
  };

  const claimLinks = bindClaims(input, draft);
  const bindingPass = claimLinks.length > 0 && claimLinks.every((link) => link.bound);
  const binding: VerificationCheck = {
    code: "claim_fragment_binding",
    executed: true,
    pass: bindingPass,
    detail: bindingPass
      ? "Каждый фрагмент найден в тексте указанного источника."
      : "Есть утверждение без фрагмента, который буквально входит в текст источника, либо утверждений нет.",
  };

  const savingsText = [draft.body, ...draft.claims.map((claim) => claim.statement)].join("\n");
  const savingsFound = MEASURED_SAVINGS.test(savingsText);
  const savingsPass = input.criteria.forbid_measured_savings_claims ? !savingsFound : true;
  const savings: VerificationCheck = {
    code: "measured_savings",
    executed: true,
    pass: savingsPass,
    detail: savingsFound
      ? "В черновике найдено обещание измеренной экономии или процента."
      : "Обещание измеренной экономии в черновике не найдено.",
  };

  const checks = [lengthCheck, sourcesSeparate, urlSyntax, binding, savings];
  const weak = claimLinks.some((link) => link.bound && link.weak);
  const failed = checks.some((check) => !check.pass);
  const status = failed ? "fail" : weak ? "needs_review" : "pass";

  const urlChecks: UrlCheck[] = input.sources.map((source) => ({
    source_id: source.source_id,
    status: "not_checked",
    checked_at: null,
    limitation: limitationsForUrlStatus("not_checked"),
  }));

  const grounds: string[] = [];
  for (const check of checks) {
    if (!check.pass) grounds.push(`${check.code}: ${check.detail}`);
  }
  if (!failed && weak) {
    grounds.push(
      `Связанный фрагмент короче ${LIMITS.weakFragmentMin} кодовых точек. Для pass этой привязки недостаточно, статус needs_review.`,
    );
  }
  if (grounds.length === 0) {
    grounds.push("Детерминированные проверки длины, отдельных ссылок и привязки фрагментов выполнены.");
  }

  return {
    status,
    grounds,
    limitations: [
      REACHABILITY_IS_NOT_TRUTH,
      FIXTURE_LIMITATION,
      "publication_status остаётся not_published. Обработчик внешней публикации отсутствует.",
      "Статус not_checked не заменяется на reachable.",
    ],
    checks,
    claim_links: claimLinks,
    url_checks: urlChecks,
    rules_version: RULES_VERSION,
    blocks_external_action: status !== "pass",
  };
}

function bindClaims(input: PrepareDraftInput, draft: ProviderDraft): ClaimLink[] {
  const byId = new Map(input.sources.map((source) => [source.source_id, source.provided_text]));
  return draft.claims.map((claim) => {
    const text = byId.get(claim.source_id);
    const bound = typeof text === "string" && claim.fragment.length > 0 && text.includes(claim.fragment);
    return {
      statement: claim.statement,
      source_id: claim.source_id,
      fragment: claim.fragment,
      bound,
      weak: bound && codePointLength(claim.fragment) < LIMITS.weakFragmentMin,
    };
  });
}

export function educationalCosts(currency: string): import("../contract/types.js").CostReport {
  const zero = (): import("../contract/types.js").Money => ({ amount: "0.00", currency });
  return {
    external: { estimate: zero(), reserved: zero(), actual: zero() },
    model: { estimate: null, reserved: null, actual: null, status: "not_measured" },
  };
}

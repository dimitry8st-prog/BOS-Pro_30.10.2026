import { MESSAGES } from "../contract/constants.js";
import type { PrepareDraftInput, ProviderResult, ProviderVariant } from "../contract/types.js";

const STANDARD_FRAGMENTS = {
  system: "Система управляемого выполнения задач с проверяемым результатом.",
  scenario: "подготовка публикации из проверенных источников",
  draft: "Наличие черновика не означает, что он опубликован.",
} as const;

export class FixtureProvider {
  readonly name = "FixtureProvider" as const;

  generate(input: PrepareDraftInput, variant: ProviderVariant): ProviderResult {
    if (variant === "refuse") {
      return {
        ok: false,
        provider: "FixtureProvider",
        code: "provider_refused",
        message: MESSAGES.provider_refused,
      };
    }
    const source = input.sources[0];
    const sourceId = source?.source_id ?? "src_missing";
    const listed = input.sources.map((item) => ({
      source_id: item.source_id,
      url: item.url,
      title: item.title,
    }));
    const claims = standardClaims(sourceId);
    if (variant === "unbound") {
      claims.push({
        statement: "В источнике есть фрагмент, которого там нет.",
        source_id: sourceId,
        fragment: "НЕТ_ТАКОГО_ФРАГМЕНТА_В_README",
      });
    }
    if (variant === "weak_fragment") {
      return {
        ok: true,
        provider: "FixtureProvider",
        variant,
        body: standardBody(input.topic, input.audience),
        claims: [
          {
            statement: "В снимке встречается имя BOS.pro.",
            source_id: sourceId,
            fragment: "BOS.pro",
          },
        ],
        sources: listed,
      };
    }
    const body =
      variant === "overlong"
        ? overlongBody()
        : variant === "savings"
          ? `${standardBody(input.topic, input.audience)}\nИзмеренная экономия составила 30%.`
          : standardBody(input.topic, input.audience);
    return {
      ok: true,
      provider: "FixtureProvider",
      variant,
      body,
      claims,
      sources: variant === "omit_sources" ? [] : listed,
    };
  }
}

export function standardBody(topic: string, audience: string): string {
  return [
    topic,
    "",
    `Коротко для аудитории: ${audience}.`,
    "",
    "В снимке README BOS.pro назван системой управляемого выполнения задач с проверяемым результатом. Первый сценарий в том же снимке — подготовка публикации из проверенных источников. Наличие черновика не означает, что он опубликован.",
    "",
    "Учебный черновик fixture. Внешняя публикация не выполняется.",
  ].join("\n");
}

function standardClaims(sourceId: string): { statement: string; source_id: string; fragment: string }[] {
  return [
    {
      statement: "BOS.pro описан как система управляемого выполнения задач с проверяемым результатом.",
      source_id: sourceId,
      fragment: STANDARD_FRAGMENTS.system,
    },
    {
      statement: "Первый сценарий в снимке — подготовка публикации из проверенных источников.",
      source_id: sourceId,
      fragment: STANDARD_FRAGMENTS.scenario,
    },
    {
      statement: "Наличие черновика не означает, что он опубликован.",
      source_id: sourceId,
      fragment: STANDARD_FRAGMENTS.draft,
    },
  ];
}

function overlongBody(): string {
  const sentence = "Проверка длины выполняется отдельно от доступности ссылки. ";
  let body = sentence;
  while ([...body].length <= 600) body += sentence;
  return body;
}

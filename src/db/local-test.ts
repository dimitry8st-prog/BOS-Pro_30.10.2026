// Пароли ниже действуют только в отдельном учебном кластере 127.0.0.1:54329.
// Это не секреты публичного сервиса и не доступ к пользовательской установке PostgreSQL.

export const LOCAL_HOST = "127.0.0.1";
export const LOCAL_PORT = 54329;
export const LOCAL_DATABASE = "bos_pro_test";
export const LOCAL_POSTGRES_IMAGE_NOTE = "PostgreSQL 16.10, отдельный каталог данных var/pg-test";

const LOCAL_PASSWORDS = {
  bos_owner: "bos_owner_local_only",
  usr_educational: "usr_educational_local_only",
  usr_other: "usr_other_local_only",
} as const;

export type LocalActor = "usr_educational" | "usr_other";

export function localPassword(user: keyof typeof LOCAL_PASSWORDS): string {
  return LOCAL_PASSWORDS[user];
}

export function isLocalActor(value: string): value is LocalActor {
  return value === "usr_educational" || value === "usr_other";
}

export function assertLocalTestUrl(url: string, actor: LocalActor): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(new Error("Нужен локальный URL учебного кластера."), { code: "usage" });
  }
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (parsed.protocol !== "postgres:" || parsed.hostname !== LOCAL_HOST || parsed.port !== String(LOCAL_PORT)) {
    throw Object.assign(new Error("Разрешён только учебный кластер 127.0.0.1:54329."), { code: "usage" });
  }
  if (parsed.pathname !== `/${LOCAL_DATABASE}`) {
    throw Object.assign(new Error("Разрешена только учебная база bos_pro_test."), { code: "usage" });
  }
  if (user !== actor || password !== localPassword(actor)) {
    throw Object.assign(new Error("Пользователь URL должен совпадать с --actor учебного адаптера."), { code: "usage" });
  }
}

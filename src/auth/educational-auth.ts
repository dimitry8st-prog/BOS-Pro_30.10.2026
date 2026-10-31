const ACTOR_ID = /^usr_[a-z0-9]{1,32}$/;

/**
 * Учебный адаптер локальных тестов.
 * Личность — роль входа PostgreSQL, выбранная запускающим тестом через --actor.
 * Поле user_id из тела запроса не читается и не доказывает личность.
 * productionReady остаётся false: это не защита публичного сервиса.
 */
export class EducationalAuthAdapter {
  readonly name = "educational-local";
  readonly productionReady = false as const;

  constructor(readonly userId: string) {
    if (!ACTOR_ID.test(userId)) {
      throw Object.assign(new Error("Идентификатор учебного пользователя должен иметь вид usr_<латиница и цифры>."), {
        code: "usage",
      });
    }
  }
}

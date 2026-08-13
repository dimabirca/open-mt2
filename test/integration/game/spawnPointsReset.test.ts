import { expect } from 'chai';
import { PointsEnum } from '@/core/enum/PointsEnum';
import Item from '@/core/domain/entities/game/item/Item';
import AttackHarness, { AttackSession } from '../../support/AttackSession';

/**
 * Regression for issue #251. `calcPointsAndResetValues` runs after the login
 * sequence has already applied the worn items, and it used to reset attack and
 * move speed to the class base without rebuilding them, and to heal to full,
 * discarding the health that had just been read from the database.
 *
 * The original resets the same way and then re-runs every worn item
 * (`ModifyPoints(true)`, char.cpp:2337-2345) and only ever clamps health
 * downward (char.cpp:2367-2371).
 *
 * The first case drives the reset through `/lvl`, which is the same
 * `calcPointsAndResetValues` the spawn takes, because the harness seeds the
 * character before the items exist and cannot log in already wearing one.
 *
 * Needs MySQL + Redis up (docker) and the game port free (stop `dev:game`).
 */
describe('Bug — the spawn reset discards what the character is wearing (issue #251)', function () {
    this.timeout(60_000);

    const WEARER = 'spawnreset_test';
    const SURVIVOR = 'spawnhealth_test';

    // Sword+0: APPLY_ATT_SPEED 22, and its only anti flag is ANTI_MUDANG, so
    // the harness's warrior can wear it.
    const SWORD_VNUM = 10;
    const SWORD_ATT_SPEED = 22;
    const STORED_HEALTH = 137;

    let harness: AttackHarness;
    const sessions: Array<AttackSession> = [];

    before(async () => {
        harness = await new AttackHarness().start();
    });

    after(async () => {
        for (const session of sessions) await session.close();
        await harness?.stop();
    });

    const settleFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('rebuilds the attack speed of the worn weapon after a points reset', async () => {
        const session = await harness.login({ username: WEARER });
        sessions.push(session);
        await session.settle(600);

        const player = harness.findPlayer(WEARER);
        expect(player, 'setup: the character reached the world').to.not.equal(undefined);

        const baseAttackSpeed = player!.getPoint(PointsEnum.ATTACK_SPEED);

        session.command(`/item ${SWORD_VNUM}`);
        await session.settle(600);

        const inventory = player!.getInventory();
        const sword = [...inventory.getItems().values()].find((item: Item) => item.getId() === SWORD_VNUM);
        expect(sword, 'setup: the command created the sword').to.not.equal(undefined);

        inventory.addItemAt(sword!, inventory.getWearPosition(sword!)!);
        expect(
            player!.getPoint(PointsEnum.ATTACK_SPEED),
            'setup: equipping the sword raised the attack speed',
        ).to.equal(baseAttackSpeed + SWORD_ATT_SPEED);

        session.command('/lvl 99');
        await session.settle(800);

        expect(player!.getPoint(PointsEnum.ATTACK_SPEED), 'the reset kept what the character is wearing').to.equal(
            baseAttackSpeed + SWORD_ATT_SPEED,
        );
    });

    it('enters the world on the health it was stored with, not on a full bar', async () => {
        const session = await harness.login({ username: SURVIVOR, health: STORED_HEALTH });
        sessions.push(session);
        await session.settle(600);

        const player = harness.findPlayer(SURVIVOR);
        expect(player, 'setup: the character reached the world').to.not.equal(undefined);

        const maxHealth = player!.getPoint(PointsEnum.MAX_HEALTH);
        expect(maxHealth, 'setup: a full bar is far above the stored value').to.be.greaterThan(STORED_HEALTH * 10);

        // Read before the first regeneration tick can lift it off the floor.
        expect(player!.getPoint(PointsEnum.HEALTH), 'the login did not hand back a full bar').to.be.lessThan(maxHealth);
        expect(player!.getPoint(PointsEnum.HEALTH), 'the stored health survived the spawn').to.be.at.least(
            STORED_HEALTH,
        );

        await settleFor(200);
    });
});

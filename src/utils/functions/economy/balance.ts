import { Collection, Guild, GuildMember } from "discord.js";
import prisma from "../../../init/database";
import redis from "../../../init/redis";
import { CustomEmbed } from "../../../models/EmbedBuilders";
import { NotificationPayload } from "../../../types/Notification";
import Constants from "../../Constants";
import { isBooster } from "../premium/boosters";
import { getTier } from "../premium/premium";
import { addNotificationToQueue, getDmSettings } from "../users/notifications";
import { getAuctionAverage } from "./auctions";
import { getBoosters } from "./boosters";
import { getGuildLevelByUser } from "./guilds";
import { gemBreak, getInventory } from "./inventory";
import { isPassive } from "./passive";
import { getPrestige } from "./prestige";
import { getBaseUpgrades, getBaseWorkers, getItems } from "./utils";
import { hasVoted } from "./vote";
import { calcWorkerValues } from "./workers";
import { getXp } from "./xp";
import ms = require("ms");
import _ = require("lodash");

export const prestigeMultiEffect = [0, 1, 2, 3, 4, 5, 6, 7, 7, 9, 10];

export async function getBalance(member: GuildMember | string) {
  let id: string;
  if (member instanceof GuildMember) {
    id = member.user.id;
  } else {
    id = member;
  }

  if (await redis.exists(`${Constants.redis.cache.economy.BALANCE}:${id}`)) {
    return parseInt(await redis.get(`${Constants.redis.cache.economy.BALANCE}:${id}`));
  }

  const query = await prisma.economy.findUnique({
    where: {
      userId: id,
    },
    select: {
      money: true,
    },
  });

  await redis.set(`${Constants.redis.cache.economy.BALANCE}:${id}`, Number(query.money));
  await redis.expire(`${Constants.redis.cache.economy.BALANCE}:${id}`, 30);

  return Number(query.money);
}

export async function updateBalance(member: GuildMember | string, amount: number) {
  let id: string;
  if (member instanceof GuildMember) {
    id = member.user.id;
  } else {
    id = member;
  }

  await prisma.economy.update({
    where: {
      userId: id,
    },
    data: {
      money: Math.floor(amount),
    },
  });
  await redis.del(`${Constants.redis.cache.economy.BALANCE}:${id}`);
}

export async function getBankBalance(member: GuildMember | string): Promise<number> {
  let id: string;
  if (member instanceof GuildMember) {
    id = member.user.id;
  } else {
    id = member;
  }

  const query = await prisma.economy.findUnique({
    where: {
      userId: id,
    },
    select: {
      bank: true,
    },
  });

  return Number(query.bank);
}

export async function updateBankBalance(member: GuildMember | string, amount: number) {
  let id: string;
  if (member instanceof GuildMember) {
    id = member.user.id;
  } else {
    id = member;
  }

  await prisma.economy.update({
    where: {
      userId: id,
    },
    data: {
      bank: amount,
    },
  });
}

export async function increaseBaseBankStorage(member: GuildMember, amount: number) {
  await prisma.economy.update({
    where: {
      userId: member.user.id,
    },
    data: {
      bankStorage: { increment: amount },
    },
  });
}

export async function getMulti(member: GuildMember | string): Promise<number> {
  let id: string;
  if (member instanceof GuildMember) {
    id = member.user.id;
  } else {
    id = member;
  }

  let multi = 0;

  const prestige = await getPrestige(member);

  let prestigeBonus = prestigeMultiEffect[prestige];

  if (!prestigeBonus && prestigeBonus !== 0) prestigeBonus = prestigeMultiEffect[prestigeMultiEffect.length - 1];

  multi += prestigeBonus;

  switch (await getTier(id)) {
    case 2:
      multi += 2;
      break;
    case 3:
      multi += 4;
      break;
    case 4:
      multi += 7;
      break;
  }

  if (await isBooster(id)) multi += 3;

  const guildLevel = await getGuildLevelByUser(id);

  if (guildLevel) {
    multi += guildLevel > 7 ? 7 : guildLevel - 1;
  }

  const boosters = await getBoosters(id);
  const items = getItems();

  if ((await getDmSettings(id)).voteReminder && !(await redis.sismember(Constants.redis.nypsi.VOTE_REMINDER_RECEIVED, id)))
    multi += 2;

  if (await isPassive(id)) multi -= 3;

  for (const boosterId of boosters.keys()) {
    if (items[boosterId].boosterEffect.boosts.includes("multi")) {
      multi += items[boosterId].boosterEffect.effect * boosters.get(boosterId).length;
    }
  }

  const inventory = await getInventory(id, false);
  if (inventory.find((i) => i.item === "crystal_heart")?.amount > 0) multi += Math.floor(Math.random() * 7);
  if (inventory.find((i) => i.item == "white_gem")?.amount > 0) {
    const chance = Math.floor(Math.random() * 10);

    if (chance < 2) {
      multi -= Math.floor(Math.random() * 6) + 1;
    } else {
      gemBreak(id, 0.01, "white_gem");
      const choices = [7, 3, 4, 5, 7, 2, 17, 7, 4, 5, 3, 3, 3, 3, 4, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3];
      multi += Math.floor(Math.random() * choices[Math.floor(Math.random() * choices.length)]) + 1;
    }
  } else if (inventory.find((i) => i.item == "pink_gem")?.amount > 0) {
    const chance = Math.floor(Math.random() * 10);

    if (chance < 2) {
      multi -= 3;
    } else {
      gemBreak(id, 0.07, "pink_gem");
      const choices = [7, 5, 4, 3, 2, 1, 3, 1, 1, 1, 3, 3];
      multi += choices[Math.floor(Math.random() * choices.length)];
    }
  }

  multi = Math.floor(multi);
  if (multi < 0) multi = 0;

  multi = multi / 100;

  return parseFloat(multi.toFixed(2));
}

export async function getMaxBankBalance(member: GuildMember | string): Promise<number> {
  let id: string;
  if (member instanceof GuildMember) {
    id = member.user.id;
  } else {
    id = member;
  }

  const base = await prisma.economy
    .findUnique({
      where: {
        userId: id,
      },
      select: {
        bankStorage: true,
      },
    })
    .then((q) => Number(q.bankStorage));

  const xp = await getXp(id);
  const constant = 1000;
  const starting = 15000;
  const bonus = xp * constant;
  const max = bonus + starting;

  return max + base;
}

export async function bottomAmount(guild: Guild, amount: number): Promise<string[]> {
  let members: Collection<string, GuildMember>;

  if (guild.memberCount == guild.members.cache.size) {
    members = guild.members.cache;
  } else {
    members = await guild.members.fetch();
  }

  if (!members) members = guild.members.cache;

  members = members.filter((m) => {
    return !m.user.bot;
  });

  const query = await prisma.economy.findMany({
    where: {
      AND: [{ money: { gt: 0 } }, { userId: { in: Array.from(members.keys()) } }],
    },
    select: {
      userId: true,
      money: true,
    },
    orderBy: {
      money: "asc",
    },
    take: amount,
  });

  const usersFinal = [];

  let count = 0;

  const getMemberID = (guild: Guild, id: string) => {
    const target = guild.members.cache.find((member) => {
      return member.user.id == id;
    });

    return target;
  };

  for (const user of query) {
    if (count >= amount) break;
    if (usersFinal.join().length >= 1500) break;

    if (Number(user.money) != 0) {
      let pos: number | string = count + 1;

      if (pos == 1) {
        pos = "🥇";
      } else if (pos == 2) {
        pos = "🥈";
      } else if (pos == 3) {
        pos = "🥉";
      }

      usersFinal[count] =
        pos + " **" + getMemberID(guild, user.userId).user.tag + "** $" + Number(user.money).toLocaleString();
      count++;
    }
  }

  return usersFinal;
}

export async function hasPadlock(member: GuildMember): Promise<boolean> {
  const cache = await redis.get(`${Constants.redis.cache.economy.PADLOCK}:${member.user.id}`);

  if (cache) {
    return cache === "y";
  }

  const query = await prisma.economy.findUnique({
    where: {
      userId: member.user.id,
    },
    select: {
      padlock: true,
    },
  });

  await redis.set(`${Constants.redis.cache.economy.PADLOCK}:${member.user.id}`, query.padlock ? "y" : "n");
  await redis.expire(`${Constants.redis.cache.economy.PADLOCK}:${member.user.id}`, Math.floor(ms("6 hours") / 1000));

  return query.padlock;
}

export async function setPadlock(member: GuildMember, setting: boolean) {
  await prisma.economy.update({
    where: {
      userId: member.user.id,
    },
    data: {
      padlock: setting,
    },
  });

  await redis.del(`${Constants.redis.cache.economy.PADLOCK}:${member.user.id}`);
}

export async function getDefaultBet(member: GuildMember): Promise<number> {
  let id: string;
  if (member instanceof GuildMember) {
    id = member.user.id;
  } else {
    id = member;
  }

  if (await redis.exists(`${Constants.redis.cache.economy.DEFAULT_BET}:${id}`)) {
    return parseInt(await redis.get(`${Constants.redis.cache.economy.DEFAULT_BET}:${id}`));
  }

  const query = await prisma.economy.findUnique({
    where: {
      userId: id,
    },
    select: {
      defaultBet: true,
    },
  });

  await redis.set(`${Constants.redis.cache.economy.DEFAULT_BET}:${id}`, query.defaultBet);
  await redis.expire(`${Constants.redis.cache.economy.DEFAULT_BET}:${id}`, 3600);

  return query.defaultBet;
}

export async function setDefaultBet(member: GuildMember, setting: number) {
  await prisma.economy.update({
    where: {
      userId: member.user.id,
    },
    data: {
      defaultBet: setting,
    },
  });

  await redis.del(`${Constants.redis.cache.economy.DEFAULT_BET}:${member.user.id}`);
}

export async function calcMaxBet(member: GuildMember): Promise<number> {
  const base = 100000;
  const voted = await hasVoted(member);
  const bonus = 50000;

  let total = base;

  if (voted) {
    total += 50000;
  }

  const prestige = await getPrestige(member);

  let calculated = total + bonus * prestige;

  if (calculated > 1_000_000) calculated = 1_000_000;

  if (await isBooster(member.user.id)) calculated += 250_000;

  const boosters = await getBoosters(member);

  for (const boosterId of boosters.keys()) {
    if (getItems()[boosterId].boosterEffect.boosts.includes("maxbet")) {
      for (let i = 0; i < boosters.get(boosterId).length; i++) {
        calculated += calculated * getItems()[boosterId].boosterEffect.effect;
      }
    }
  }

  return calculated;
}

export async function getRequiredBetForXp(member: GuildMember): Promise<number> {
  let requiredBet = 1000;

  const prestige = await getPrestige(member);

  if (prestige > 2) requiredBet = 10000;

  requiredBet += prestige * 1000;

  return requiredBet;
}

export async function calcNetWorth(member: GuildMember | string, breakdown = false) {
  let id: string;
  if (member instanceof GuildMember) {
    id = member.user.id;
  } else {
    id = member;
  }

  if (!breakdown && (await redis.exists(`${Constants.redis.cache.economy.NETWORTH}:${id}`))) {
    return { amount: parseInt(await redis.get(`${Constants.redis.cache.economy.NETWORTH}:${id}`)) };
  }

  const query = await prisma.economy.findUnique({
    where: {
      userId: id,
    },
    select: {
      money: true,
      bank: true,
      Inventory: true,
      netWorth: true,
      EconomyWorker: {
        include: {
          upgrades: true,
        },
      },
      EconomyGuildMember: {
        select: {
          guild: {
            select: {
              balance: true,
              level: true,
              members: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
      },
    },
  });

  let worth = 0;
  const breakdownItems = new Map<string, number>();

  if (!query) {
    await redis.set(`${Constants.redis.cache.economy.NETWORTH}:${id}`, worth);
    await redis.expire(`${Constants.redis.cache.economy.NETWORTH}:${id}`, ms("1 hour") / 1000);

    return { amount: worth };
  }

  worth += Number(query.money);
  worth += Number(query.bank);

  if (breakdown) breakdownItems.set("balance", worth);

  if (query.EconomyGuildMember?.guild) {
    let guildWorth = Number(query.EconomyGuildMember.guild.balance) / query.EconomyGuildMember.guild.members.length;

    for (let i = 0; i < query.EconomyGuildMember.guild.level; i++) {
      const baseMoney = 3000000 * Math.pow(i, 2.57);
      const bonusMoney = 100000 * query.EconomyGuildMember.guild.members.length;

      guildWorth += Math.floor(baseMoney + bonusMoney);
    }

    worth += Math.floor(guildWorth / query.EconomyGuildMember.guild.members.length);
    if (breakdown) breakdownItems.set("guild", Math.floor(guildWorth / query.EconomyGuildMember.guild.members.length));
  } else if (breakdown) {
    breakdownItems.set("guild", 0);
  }

  for (const item of query.Inventory) {
    if (item.item === "cookie" || ["prey", "fish", "sellable", "ore"].includes(getItems()[item.item].role)) {
      worth += getItems()[item.item].sell * Number(item.amount);
      if (breakdown) breakdownItems.set(item.item, getItems()[item.item].sell * Number(item.amount));
    } else if (getItems()[item.item].buy && getItems()[item.item].sell) {
      worth += getItems()[item.item].sell * Number(item.amount);
      if (breakdown) breakdownItems.set(item.item, getItems()[item.item].sell * Number(item.amount));
    } else {
      const auctionAvg = await getAuctionAverage(item.item);

      if (auctionAvg) {
        worth += auctionAvg * Number(item.amount);
        if (breakdown) breakdownItems.set(item.item, auctionAvg * Number(item.amount));
      } else if (getItems()[item.item].sell) {
        worth += getItems()[item.item].sell * Number(item.amount);
        if (breakdown) breakdownItems.set(item.item, getItems()[item.item].sell * Number(item.amount));
      }
    }
  }

  let workersBreakdown = 0;

  for (const worker of query.EconomyWorker) {
    const baseUpgrades = getBaseUpgrades();
    const baseWorkers = getBaseWorkers();

    for (const upgrade of worker.upgrades) {
      if (!baseUpgrades[upgrade.upgradeId].base_cost) {
        const itemId = Array.from(Object.keys(getItems())).find(
          (i) => getItems()[i].worker_upgrade_id === upgrade.upgradeId
        );
        if (!itemId) continue;

        worth += upgrade.amount * ((await getAuctionAverage(itemId)) || 100000);
      } else {
        let baseCost = _.clone(baseUpgrades[upgrade.upgradeId]).base_cost;

        baseCost =
          baseCost *
          (baseWorkers[upgrade.workerId].prestige_requirement >= 4
            ? baseWorkers[upgrade.workerId].prestige_requirement / 2
            : baseWorkers[upgrade.workerId].prestige_requirement - 0.5 < 1
            ? 1
            : baseWorkers[upgrade.workerId].prestige_requirement - 0.5);

        // zack's formula ((price+amount×price)×amount)/2

        const cost = ((baseCost + upgrade.amount * baseCost) * upgrade.amount) / 2;

        worth += cost;
        workersBreakdown += cost;
      }
    }

    const { perItem } = await calcWorkerValues(worker);

    worth += worker.stored * perItem;
    workersBreakdown += worker.stored * perItem;
  }

  breakdownItems.set("workers", workersBreakdown);

  await redis.set(`${Constants.redis.cache.economy.NETWORTH}:${id}`, Math.floor(worth));
  await redis.expire(`${Constants.redis.cache.economy.NETWORTH}:${id}`, ms("2 hour") / 1000);

  await prisma.economy.update({
    where: {
      userId: id,
    },
    data: {
      netWorth: Math.floor(worth),
    },
  });

  setImmediate(async () => {
    if (query.netWorth && (await getDmSettings(id)).netWorth > 0) {
      const payload: NotificationPayload = {
        memberId: id,
        payload: {
          content: "",
          embed: new CustomEmbed(
            null,
            `$${Number(query.netWorth).toLocaleString()} ➔ $${Math.floor(worth).toLocaleString()}`
          ).setColor(Constants.TRANSPARENT_EMBED_COLOR),
        },
      };

      if (Number(query.netWorth) < Math.floor(worth) - (await getDmSettings(id)).netWorth) {
        payload.payload.content = `your net worth has increased by $${(
          Math.floor(worth) - Number(query.netWorth)
        ).toLocaleString()}`;
      } else if (Number(query.netWorth) > Math.floor(worth) + (await getDmSettings(id)).netWorth) {
        payload.payload.content = `your net worth has decreased by $${(
          Number(query.netWorth) - Math.floor(worth)
        ).toLocaleString()}`;
      } else {
        return;
      }

      await addNotificationToQueue(payload);
    }
  });

  return { amount: Math.floor(worth), breakdown: breakdownItems };
}

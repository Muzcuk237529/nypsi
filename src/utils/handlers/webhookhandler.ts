import * as topgg from "@top-gg/sdk";
import { ClusterManager } from "discord-hybrid-sharding";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageActionRowComponentBuilder, WebhookClient } from "discord.js";
import * as express from "express";
import prisma from "../../init/database";
import redis from "../../init/redis";
import { CustomEmbed } from "../../models/EmbedBuilders";
import { KofiResponse } from "../../types/Kofi";
import { NotificationPayload } from "../../types/Notification";
import Constants from "../Constants";
import { addProgress } from "../functions/economy/achievements";
import { getBalance, updateBalance } from "../functions/economy/balance";
import { addBooster } from "../functions/economy/boosters";
import { addInventoryItem } from "../functions/economy/inventory";
import { getPrestige } from "../functions/economy/prestige";
import { addTicket, getItems, getTickets, isEcoBanned, loadItems, userExists } from "../functions/economy/utils";
import { addKarma } from "../functions/karma/karma";
import { addMember, getPremiumProfile, isPremium, renewUser, setTier } from "../functions/premium/premium";
import { percentChance } from "../functions/random";
import requestDM from "../functions/requestdm";
import { isUserBlacklisted } from "../functions/users/blacklist";
import { addNotificationToQueue, getDmSettings } from "../functions/users/notifications";
import { logger } from "../logger";
import ms = require("ms");

loadItems(false);

const app = express();
const webhook = new topgg.Webhook("123");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

export function listen(manager: ClusterManager) {
  app.post(
    "/dblwebhook",
    webhook.listener((vote) => {
      logger.info(`received vote: ${vote.user}`);
      doVote(vote, manager);
    })
  );

  app.post("/kofi", async (req, response) => {
    const data = JSON.parse(req.body.data) as KofiResponse;

    logger.info("received kofi data", data);

    if (data.verification_token != process.env.KOFI_VERIFICATION) {
      logger.error("received faulty kofi data", data);
      return;
    }

    response.status(200).send();

    return handleKofiData(data);
  });

  app.listen(process.env.EXPRESS_PORT || 5000);

  logger.info(`listening on port ${process.env.EXPRESS_PORT || 5000}`);
}

async function doVote(vote: topgg.WebhookPayload, manager: ClusterManager) {
  const { user } = vote;

  await redis.srem(Constants.redis.nypsi.VOTE_REMINDER_RECEIVED, user);

  if (!(await userExists(user))) {
    logger.warn(`${user} doesnt exist`);
    return;
  }

  if (await isUserBlacklisted(user)) {
    logger.info(`${user} blacklisted`);
    return;
  }

  const now = new Date().getTime();

  const query = await prisma.economy.findUnique({
    where: {
      userId: user,
    },
    select: {
      lastVote: true,
    },
  });

  const lastVote = query.lastVote.getTime();

  if (now - lastVote < 25200000) {
    return logger.error(`${user} already voted`);
  }

  await prisma.economy.update({
    where: {
      userId: user,
    },
    data: {
      lastVote: new Date(now),
    },
  });

  redis.set(`${Constants.redis.cache.economy.VOTE}:${user}`, "true");
  redis.expire(`${Constants.redis.cache.economy.VOTE}:${user}`, ms("1 hour") / 1000);

  let prestige = await getPrestige(user);

  if (prestige > 15) prestige = 15;

  const amount = Math.floor(15000 * (prestige / 2 + 1));

  if (!(await isEcoBanned(user))) {
    try {
      await Promise.all([
        updateBalance(user, (await getBalance(user)) + amount),
        addKarma(user, 10),
        addBooster(user, "vote_booster"),
        redis.del(`${Constants.redis.cache.economy.VOTE}:${user}`),
        redis.del(`${Constants.redis.cache.economy.BOOSTERS}:${user}`),
      ]).catch((e) => {
        logger.error("vote error", e);
      });
    } catch (e) {
      logger.error("vote error", e);
    }
  }

  const tickets = await getTickets(user);

  if (tickets.length <= Constants.LOTTERY_TICKETS_MAX - 1) {
    await addTicket(user, 1);
  }

  const crateAmount =
    Constants.VOTE_CRATE_PROGRESSION[prestige] ||
    Constants.VOTE_CRATE_PROGRESSION[Constants.VOTE_CRATE_PROGRESSION.length - 1];

  await addInventoryItem(user, "vote_crate", crateAmount, false);

  if (percentChance(0.05) && !(await redis.exists(Constants.redis.nypsi.GEM_GIVEN))) {
    await redis.set(Constants.redis.nypsi.GEM_GIVEN, "t");
    await redis.expire(Constants.redis.nypsi.GEM_GIVEN, Math.floor(ms("1 days") / 1000));
    await addInventoryItem(user, "blue_gem", 1);
    addProgress(user, "gem_hunter", 1);

    if ((await getDmSettings(user)).other) {
      await addNotificationToQueue({
        memberId: user,
        payload: {
          embed: new CustomEmbed()
            .setDescription(`${getItems()["blue_gem"].emoji} you've found a gem! i wonder what powers it holds...`)
            .setTitle("you've found a gem")
            .setColor(Constants.TRANSPARENT_EMBED_COLOR),
        },
      });
    }
  }

  logger.info(`::success vote processed for ${user}`);

  if ((await getDmSettings(user)).vote) {
    const embed = new CustomEmbed()
      .setColor(Constants.EMBED_SUCCESS_COLOR)
      .setDescription(
        "you have received the following: \n\n" +
          `+ $**${amount.toLocaleString()}**\n` +
          "+ **5**% multiplier\n" +
          `+ **${crateAmount}** vote crates` +
          `${tickets.length <= Constants.LOTTERY_TICKETS_MAX - 1 ? "\n+ **1** lottery ticket" : ""}`
      )
      .disableFooter();

    if (!(await getDmSettings(user)).voteReminder) {
      const chance = Math.floor(Math.random() * 10);

      if (chance == 7) {
        embed.setFooter({ text: "you can enable vote reminders with /settings me notifications" });
      }
    }

    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setLabel("open crates").setCustomId("vote-crates").setStyle(ButtonStyle.Success)
    );

    const res = await requestDM({
      memberId: user,
      client: manager,
      content: "thank you for voting!",
      embed: embed,
      components: row,
    });

    if (!res) {
      logger.warn(`failed to send vote confirmation to ${user}`);
    }
  }
}

async function handleKofiData(data: KofiResponse) {
  const user = await prisma.user.findFirst({
    where: {
      AND: [{ email: data.email }, { blacklisted: false }],
    },
  });

  logger.info(`received kofi purchase for email: ${data.email} item ${data.tier_name || JSON.stringify(data.shop_items)}`);

  if (data.shop_items && data.shop_items.length > 0) {
    for (const shopItem of data.shop_items) {
      const item = Constants.KOFI_PRODUCTS.get(shopItem.direct_link_code);

      if (!item) {
        return logger.error(`invalid item: ${shopItem.direct_link_code}`, data);
      }

      if (!shopItem.quantity) {
        logger.error(`invalid quantity: ${JSON.stringify(shopItem)}`);
        return;
      }

      for (let i = 0; i < shopItem.quantity; i++) {
        if (user) {
          await addInventoryItem(user.id, item, 1, false);

          logger.info(`${item} given to ${user.id} (${user.email})`);

          if ((await getDmSettings(user.id)).premium) {
            const payload: NotificationPayload = {
              memberId: user.id,
              payload: {
                content: "thank you for your purchase",
                embed: new CustomEmbed()
                  .setDescription(`you have received 1 ${getItems()[item].emoji} **${getItems()[item].name}**`)
                  .setColor(Constants.TRANSPARENT_EMBED_COLOR),
              },
            };

            await addNotificationToQueue(payload);
            if (data.is_public) {
              const hook = new WebhookClient({ url: process.env.THANKYOU_HOOK });
              await hook.send({
                embeds: [
                  new CustomEmbed(
                    null,
                    `${user.lastKnownTag.split("#")[0]} just bought a ${getItems()[item].emoji} **${
                      getItems()[item].name
                    }**!!!!`
                  ).setFooter({ text: "thank you for your purchase (:" }),
                ],
              });
              hook.destroy();
            }
          }

          const gemChance = Math.floor(Math.random() * 77);

          if (gemChance == 7) {
            await addInventoryItem(user.id, "pink_gem", 1);
            addProgress(user.id, "gem_hunter", 1);

            if ((await getDmSettings(user.id)).other) {
              await addNotificationToQueue({
                memberId: user.id,
                payload: {
                  embed: new CustomEmbed()
                    .setDescription(`${getItems()["pink_gem"].emoji} you've found a gem! i wonder what powers it holds...`)
                    .setTitle("you've found a gem")
                    .setColor(Constants.TRANSPARENT_EMBED_COLOR),
                },
              });
            }
          } else if (gemChance == 17) {
            await addInventoryItem(user.id, "blue_gem", 1);
            addProgress(user.id, "gem_hunter", 1);

            if ((await getDmSettings(user.id)).other) {
              await addNotificationToQueue({
                memberId: user.id,
                payload: {
                  embed: new CustomEmbed()
                    .setDescription(`${getItems()["blue_gem"].emoji} you've found a gem! i wonder what powers it holds...`)
                    .setTitle("you've found a gem")
                    .setColor(Constants.TRANSPARENT_EMBED_COLOR),
                },
              });
            }
          } else if (gemChance == 77) {
            await addInventoryItem(user.id, "purple_gem", 1);
            addProgress(user.id, "gem_hunter", 1);

            if ((await getDmSettings(user.id)).other) {
              await addNotificationToQueue({
                memberId: user.id,
                payload: {
                  embed: new CustomEmbed()
                    .setDescription(`${getItems()["purple_gem"].emoji} you've found a gem! i wonder what powers it holds...`)
                    .setTitle("you've found a gem"),
                },
              });
            }
          } else if (gemChance == 27) {
            await addInventoryItem(user.id, "green_gem", 1);
            addProgress(user.id, "gem_hunter", 1);

            if ((await getDmSettings(user.id)).other) {
              await addNotificationToQueue({
                memberId: user.id,
                payload: {
                  embed: new CustomEmbed()
                    .setDescription(`${getItems()["green_gem"].emoji} you've found a gem! i wonder what powers it holds...`)
                    .setTitle("you've found a gem")
                    .setColor(Constants.TRANSPARENT_EMBED_COLOR),
                },
              });
            }
          } else if (gemChance == 57) {
            const gemChance2 = Math.floor(Math.random() * 50);

            if (gemChance2 == 7 && (await getDmSettings(user.id)).other) {
              await addInventoryItem(user.id, "white_gem", 1);
              addProgress(user.id, "gem_hunter", 1);

              await addNotificationToQueue({
                memberId: user.id,
                payload: {
                  embed: new CustomEmbed()
                    .setDescription(`${getItems()["white_gem"].emoji} you've found a gem! i wonder what powers it holds...`)
                    .setTitle("you've found a gem")
                    .setColor(Constants.TRANSPARENT_EMBED_COLOR),
                },
              });
            }
          }
        } else {
          await prisma.kofiPurchases.create({
            data: {
              email: data.email,
              item: item,
            },
          });

          logger.info(`created purchase for ${data.email} ${item}`);
        }
      }
    }
  }

  if (data.tier_name) {
    const item = Constants.KOFI_PRODUCTS.get(data.tier_name.toLowerCase());

    if (!item) {
      logger.error(`invalid tier: ${data.tier_name}`, data);
      console.log(data);
      return;
    }

    const premiums = ["platinum", "gold", "silver", "bronze"].reverse();

    if (!premiums.includes(item)) {
      logger.error("invalid premium", data);
      return;
    }

    if (user) {
      if (await isPremium(user.id)) {
        if ((await getPremiumProfile(user.id)).getLevelString().toLowerCase() != item) {
          await setTier(user.id, premiums.indexOf(item) + 1);
          await renewUser(user.id);
          if (data.is_public) {
            const hook = new WebhookClient({ url: process.env.THANKYOU_HOOK });
            await hook.send({
              embeds: [
                new CustomEmbed(null, `${user.lastKnownTag.split("#")[0]} just bought **${item}**!!!!`).setFooter({
                  text: "thank you for your purchase (:",
                }),
              ],
            });
            hook.destroy();
          }
        } else {
          await renewUser(user.id);
        }
      } else {
        await addMember(user.id, premiums.indexOf(item) + 1);
        if (data.is_public) {
          const hook = new WebhookClient({ url: process.env.THANKYOU_HOOK });
          await hook.send({
            embeds: [
              new CustomEmbed(null, `${user.lastKnownTag.split("#")[0]} just bought **${item}**!!!!`).setFooter({
                text: "thank you for your purchase (:",
              }),
            ],
          });
          hook.destroy();
        }
      }
    } else {
      await prisma.kofiPurchases.create({
        data: {
          email: data.email,
          item: item,
        },
      });
      logger.info(`created purchase for ${data.email} ${item}`);
    }
  }
}

import { CommandInteraction, Message } from "discord.js";
import { Command, NypsiCommandInteraction } from "../models/Command";
import { ErrorEmbed } from "../models/EmbedBuilders";
import Constants from "../utils/Constants";
import { addNotificationToQueue } from "../utils/functions/users/notifications";

const cmd = new Command(
  "requestdm",
  "attempt to send a DM to a given user (this is my way of having fun leave me alone)",
  "none"
);

async function run(message: Message | (NypsiCommandInteraction & CommandInteraction), args: string[]) {
  if (!Constants.ADMIN_IDS.includes(message.author.id)) return;

  if (args.length < 2) {
    return message.channel.send({ embeds: [new ErrorEmbed("$requestdm <id> <content>")] });
  }

  const user = args[0];

  args.shift();

  await addNotificationToQueue({
    memberId: user,
    payload: {
      content: args.join(" "),
    },
  });

  if (!(message instanceof Message)) return;

  message.react("✅");
}

cmd.setRun(run);

module.exports = cmd;

const cooldown = new Map()

module.exports = {
    name: "delp",
    description: "bulk delete/purge your own messages",
    category: "info",
    run: async (message, args) => {
        if (cooldown.has(message.member.id)) {
            const init = cooldown.get(message.member.id)
            const curr = new Date()
            const diff = Math.round((curr - init) / 1000)
            const time = 30 - diff

            const minutes = Math.floor(time / 60)
            const seconds = time - minutes * 60

            let remaining

            if (minutes != 0) {
                remaining = `${minutes}m${seconds}s`
            } else {
                remaining = `${seconds}s`
            }
            return message.channel.send("❌ still on cooldown for " + remaining);
        }

        if (!message.guild.me.hasPermission("MANAGE_MESSAGES")) {
            return message.channel.send("❌ i am lacking permission: 'MANAGE_MESSAGES'");
        }

        if (args.length == 0) {
            args[0] = 7
        }

        if (isNaN(args[0]) || parseInt(args[0]) <= 0) {
            return message.channel.send("❌ $delp <amount> (@user)");
        }

        let amount = parseInt(args[0])

        if (!message.member.hasPermission("ADMINISTRATOR")) {
            if (!message.member.hasPermission("MANAGE_MESSAGES")) {
                if (amount > 7) {
                    amount = 7
                }
            } else {
                if (amount > 50) {
                    amount = 50
                }
            }
            cooldown.set(message.member.id, new Date());
    
            setTimeout(() => {
                cooldown.delete(message.member.id);
            }, 30000);
        }

        let target = message.member

        if (message.member.hasPermission("MANAGE_MESSAGES")) {
            if (message.mentions.members.first()) {
                target = message.mentions.members.first()
            }
        }

        if (amount > 100) amount = 100

        await message.delete().catch()

        const collected = await message.channel.messages.fetch({limit: 100})

        const collecteda = collected.filter(msg => msg.member.user.id == target.user.id)

        let count = 0

        for (msg of collecteda.array()) {
            if (count >= amount) break
            await msg.delete().catch()
            count++
        }

        message.channel.send("✅ **successfully deleted " + count + " messages**").then(m => m.delete({timeout: 5000}))    
    }
}
# Privacy for the Luca assistant connection

This connection has no database of its own. It sends a request to Luca under
your access and returns Luca's answer to your assistant. The hosted connection
does not retain your workspace data between requests. Your conversations and
other records remain in Luca under [Luca's privacy policy](https://setluca.com/privacy).

The server records the name of a tool, whether it succeeded, and how long it
took. It does not put API keys, message text, tool arguments, or drafted replies
in those logs.

Your assistant receives the result of each request you make through it. Its
provider may handle that result under a separate privacy policy. Read that
policy before connecting a live workspace. Luca sends requests from this
connection only to the Luca API; it does not send workspace data to another
service of its own.

You can disconnect a hosted assistant in **Luca → Settings → Connected agents**
or revoke a developer API key in **Luca → Settings → Developer API keys**.
Revoking a key stops clients that use it. For privacy questions, contact
[hello@setluca.com](mailto:hello@setluca.com).

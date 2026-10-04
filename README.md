# Linkboard

A classic link-aggregator board with username and password accounts. It has boards, voting, threaded comments, an inbox, moderation, and live updates.

It needs nothing except Node.js 18 or newer. There are no packages to install.

## Run it on your computer

```
node server.js
```

Then open http://localhost:3000. **The first account you create becomes the site admin.** Admins moderate the built-in boards (pics, cooking and so on). Whoever creates a board moderates that board.

Everything is saved in `data/linkboard.json`. Back up that file to back up the site.

## Put it online for free

This uses three free services. None of them needs a credit card to start.

- **GitHub** holds the code.
- **Render** runs the site.
- **Upstash** stores the data. Render's free plan wipes its disk on every restart, so the data has to live elsewhere.
- **Cloudinary** (optional) stores uploaded images and videos, for the same reason. Without it the site works, but people can only link to pictures and videos hosted elsewhere.

**1. Create the database.** Sign up at upstash.com and create a Redis database (any region near you). On the database page, find the **REST API** section and copy two values: the URL (starts with `https://`) and the token.

**2. Put the code on GitHub.** Sign up at github.com, then click **New repository**. Name it `linkboard` and create it. On the empty repository page, choose **uploading an existing file**. Drag in everything from this folder (`server.js`, `package.json`, `render.yaml`, `README.md`, and the `public` and `scripts` folders), then click **Commit changes**.

**3. Run it on Render.** Sign up at render.com with your GitHub account, then go to **New → Blueprint** and pick the `linkboard` repository. Render reads `render.yaml` and asks for three values:

- `UPSTASH_REDIS_REST_URL`: the URL from step 1.
- `UPSTASH_REDIS_REST_TOKEN`: the token from step 1.
- `ADMIN_USERS`: the username you will sign up with, so you are the admin.
- `CLOUDINARY_URL` (optional, for uploads): sign up at cloudinary.com, open the dashboard, and copy the **API environment variable**. It looks like `cloudinary://123456:abcdef@your-cloud-name`. You can also add this later under your service's **Environment** tab on Render.

Click **Apply**. After a minute or two, the site is live at an address like `https://linkboard-xxxx.onrender.com`.

**4. Sign up** on your new site with the username you gave as `ADMIN_USERS`.

What the free plans mean in practice:

- **Waking up:** the site goes to sleep after 15 minutes with no visitors. The next visit takes up to about a minute to wake it, then it's quick again.
- **Database allowance:** Upstash's free plan allows 500,000 database commands a month. Linkboard batches changes into one save every few seconds, which is plenty for a small community.
- **Updating the site:** upload the changed files to the GitHub repository and Render redeploys on its own. Your data stays in Upstash.

## Settings

All optional when you run it yourself.

| setting | what it does |
| --- | --- |
| `PORT` | port to listen on (default 3000) |
| `DATA_DIR` | where to keep `linkboard.json` when not using Upstash (default `./data`) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | store data in an Upstash database instead of a file |
| `COOKIE_SECURE=1` | set this once the site is served over **https**, so login cookies are only sent securely |
| `TRUST_PROXY=1` | set this when the site runs behind a reverse proxy or load balancer, as on Render, so login throttling sees each visitor's real address |
| `CLOUDINARY_URL` | send uploaded images and videos to your Cloudinary account (`cloudinary://key:secret@cloud`) |
| `UPLOADS=off` | turn uploads off completely |
| `ADMIN_USERS` | comma-separated usernames that are always admins, e.g. `ADMIN_USERS=adit,river_otter` |

Always serve the public site over https: passwords travel from the browser to the server when people sign up and log in. Render does this for you.

## Uploads

People can upload images (jpg, png, gif, webp, up to 20 MB) and videos (mp4, webm, mov, up to 100 MB) from the submit page. Files are checked by their contents, not their names. Each account can upload 20 files an hour.

- With `CLOUDINARY_URL` set, files go straight from the browser to your Cloudinary account, which also makes web-sized copies.
- Without it, on your own computer, files are saved in `data/media` next to `linkboard.json`. Back that folder up too.
- Without it on a host that stores data in Upstash (like Render), uploads are off, because the disk is wiped on restart.

Deleting a post doesn't delete its uploaded file.

YouTube links play right on the page (through youtube-nocookie.com), and links straight to .mp4 or .webm files play in a video player.

Image posts load the picture straight from the site it's hosted on, so visitors' browsers contact that site, as on the classic site.

## Accounts

- Usernames are 3 to 20 characters: letters, numbers, `-` and `_`. They are unique regardless of capitals.
- Passwords need at least 8 characters. They are stored only as salted scrypt hashes, never as plain text.
- "Remember me" keeps someone logged in for a year. Without it, the login lasts a day.
- People can change their password under **preferences**. That logs them out everywhere else.
- After 10 wrong passwords for a username, or from one address, logins pause for 15 minutes.
- There is no email, so "reset password" can't send a link. **Admins reset passwords under preferences** on the site.

If you run the site yourself, you can also manage accounts from the server. Stop the server first, then run:

```
node scripts/manage.js reset-password <username> <new password>
node scripts/manage.js make-admin <username>
node scripts/manage.js remove-admin <username>
```

## What's in it

- **Boards and listings:** best, hot, new, rising, controversial and top (with time ranges), popular, all, a friends feed, your own custom feeds, trending boards, and domain pages.
- **Posts:** links, text, image and video uploads, image links (shown as real pictures), YouTube videos that play inline, crossposts, NSFW and spoiler tags, flair, editing and deleting. Posts over six months old are archived and take no new votes or comments.
- **Comments:** threaded, collapsible, sortable, "continue this thread" and "load more", new-comment highlighting, and permalinks.
- **Formatting:** bold, italics, strikethrough, links, lists, quotes, headings, spoilers (`>!like this!<`), code blocks, tables and divider lines.
- **People:** profiles with karma and a trophy case, friends, blocking, private messages, username mentions, an inbox and preferences (night mode, NSFW content, links per page, and more).
- **Chat:** live one-to-one and group chats in a window docked at the bottom right, opened from the speech-bubble icon in the header or "start a chat" on a profile. Chats from people who haven't friended you arrive as requests you can accept, ignore or block. Groups can be named and take up to 20 people.
- **Moderation:** sticky posts and comments, lock, remove (with a reason the author sees) and approve, distinguish, permanent or temporary bans, a reports queue, a moderation log, moderator mail, board settings (rules, submission text, links-only or text-only, flair, user flair, header color, restricted posting, hidden scores, suggested sort, NSFW), a wiki per board, and co-moderators.
- **Links:** every post, board, user, search and domain has its own address, and the back button works.
- **RSS:** `/rss` for the whole site and `/b/<board>/rss` for one board.

Admins can also post a site-wide announcement and reset passwords under **preferences**.

New accounts are limited to 5 posts, 40 comments, 15 messages, 40 chat messages a minute, 10 new chats an hour and 3 new boards in a short window, so one account can't flood the site.

## Who can change what

- Anyone can read the site without an account.
- Logged-in people can post, comment, vote, report, join boards and create boards. The server only lets each person change their own posts, comments and votes.
- Moderation for a board you created is stored with your account, so only you can moderate it. Moderation of the built-in boards is admin-only.
- Saved and hidden posts, friends and blocked lists, custom feeds, preferences and inbox read state are private to each person.
- Chats can only be read by the people in them. Messages from someone you've blocked are never shown to you.
- Private messages can only be read by the sender and recipient. Messages to `b/<board>` go to that board's moderators. If someone has blocked you, your messages to them aren't delivered.
- A board's creator can add up to 10 co-moderators. Only the creator, or a site admin, can change that list.
- Deleting an account (under preferences) removes the account, its votes, settings and messages, and frees the username. Its posts and comments stay up, shown as written by [deleted].

## Limits

Everything is kept in one JSON object, saved to a file or to Upstash. That suits a community of up to a few hundred active people. Past that, the storage should move to a real database.

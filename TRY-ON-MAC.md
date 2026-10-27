# Try pi-setup on your Mac

This guide is for someone who has never used pi. It takes about 10 minutes. The installer asks before it installs or changes anything.

## What you need

- A Mac (Apple silicon or Intel) and your login password.
- A GitHub account.
- At least one AI subscription: Claude (Anthropic) or ChatGPT (OpenAI). Kimi is optional.

## 1. Open Terminal

Press `⌘ Space`, type **Terminal** and press Return.

## 2. Install

Paste this line and press Return:

```sh
curl -fsSL https://github.com/woksin/pi-setup/releases/latest/download/bootstrap.sh | sh
```

If macOS asks to install the **command line developer tools**, click **Install**.

It shows what your Mac already has and what it will install (Homebrew, Node.js, a few command-line tools and pi), then asks `Continue? [Y/n]`. Press Return to accept. Homebrew may ask for your Mac password; that is normal.

The installer asks a few questions. When you are unsure, press Return to take the recommended answer.

## 3. Log in

At the end, the installer prints a short numbered list of what is left. Usually that is:

1. **Open a new Terminal window**, so the new tools are on your path.
2. **GitHub:** run `gh auth login` and follow the prompts (choose GitHub.com and log in with a web browser).
3. **AI:** run `pi`, type `/login`, pick Claude or ChatGPT and log in in the browser. Type `/quit` to leave pi.
4. **Finish:** run `cd ~/pi-setup && ./install.sh --profile auto`. This picks the right setup for the logins you have.

## 4. Try it

Go to any project folder and start pi:

```sh
cd ~/path/to/a/project
pi
```

Then ask for something, for example: *"Explain what this project does and how it is structured."*

## If something goes wrong

- Run `./install.sh doctor` in `~/pi-setup`. It tells you what is missing and how to fix it.
- Re-running `./install.sh` is always safe: it continues where it stopped.
- The installer writes a log to `~/.local/state/pi-setup/install.log`.

## Remove it again

```sh
cd ~/pi-setup && ./install.sh uninstall
```

This removes the setup's files and restores anything it replaced. Homebrew, Node.js and pi stay installed; remove pi with `npm uninstall -g @earendil-works/pi-coding-agent` if you want.

More detail: [README](README.md).

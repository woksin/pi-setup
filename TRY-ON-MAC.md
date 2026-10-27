# Try pi-setup on your Mac

This guide sets up pi the way we recommend it, including parallel sessions. It assumes you have never used pi or Terminal much. It takes about 15 minutes, and the installer asks before it installs or changes anything.

**What is pi?** pi is an AI coding assistant that runs in Terminal. You start it in a project folder, type what you want in plain language, and it reads the code, runs commands and edits files for you. pi-setup adds our rules, helper agents and tools on top of it.

## What you need

- A Mac (Apple silicon or Intel) and your Mac login password.
- A GitHub account, and your GitHub username at hand.
- At least one AI subscription: Claude (Anthropic) or ChatGPT (OpenAI). Kimi is optional.

## 1. Open Terminal

Press `⌘ Space`, type **Terminal** and press Return. A window with a text prompt opens.

In this guide, "run" means: copy the command, paste it into Terminal with `⌘ V`, and press Return. Wait until the prompt comes back before running the next one.

## 2. Get the setup

Run:

```sh
git clone https://github.com/woksin/pi-setup ~/pi-setup && cd ~/pi-setup
```

If macOS says it needs the **command line developer tools**, click **Install** and wait for it to finish (a few minutes). Then run the same line again.

## 3. Run the installer

Run the recommended setup with parallel sessions turned on:

```sh
./install.sh --with lanes
```

- It shows what your Mac already has and what it will install (Homebrew, Node.js, a few command-line tools and pi), then asks `Continue? [Y/n]`. Press Return.
- Homebrew asks for your **Mac password**. Type it and press Return. Nothing appears while you type; that is normal.
- When it asks for your **GitHub login**, type your GitHub username.
- For every other question, press Return to take the recommended answer. If it says you have no AI logins yet, continue anyway; you log in in step 5.
- On the review screen, keep "Add them to PATH in your shell profile" selected if it is shown, and choose **Install**.

At the end it shows **What's next**. Keep that window open for now.

## 4. Make the new tools available

On Apple silicon Macs, Homebrew must be added to your shell once. Run this (it does nothing on Intel Macs, and is safe to run twice):

```sh
[ -x /opt/homebrew/bin/brew ] && ! grep -q 'brew shellenv' ~/.zprofile 2>/dev/null && echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
```

Now **quit Terminal completely** (`⌘ Q`) and open it again (step 1). From here on, use the new window.

Check that everything is found:

```sh
pi --version && gh --version
```

Both should print a version number. If one says `command not found`, see "If something goes wrong" below.

## 5. Log in

1. **GitHub:** run `gh auth login`. Choose **GitHub.com**, **HTTPS**, answer **Yes** to authenticate Git, and **Login with a web browser**. Copy the code it shows, press Return, and paste the code in the browser.
2. **AI:** run `pi`. Inside pi, type `/login` and press Return, pick Claude or ChatGPT, and log in in the browser. Repeat `/login` for the other one if you have both. Type `/quit` to leave pi.

## 6. Finish the setup

Run:

```sh
cd ~/pi-setup && ./install.sh --with lanes --profile auto
```

This picks the right model setup for the logins you have. Then check the setup:

```sh
./install.sh doctor
```

It should end without errors. Warnings about optional tools (Docker, gitleaks, tmux, CodeScene) are fine.

## 7. Try it

Start pi in a project folder. If you have a project already:

```sh
cd ~/path/to/your/project
pi
```

If you don't, make a small test project:

```sh
mkdir -p ~/pi-test && cd ~/pi-test && git init && pi
```

Then type a request and press Return, for example:

- *"Explain what this project does and how it is structured."*
- In the test project: *"Create a small web page that shows today's date, and tell me how to open it."*

Useful to know:

- pi works only in the folder you start it in. Start it in the project you want it to work on.
- Press `Esc` to stop pi while it is working. Type `/quit` to leave.
- Run `pi -c` to continue your last session in that folder.
- pi can change files and run commands, so try it first in a project that is in git, where every change can be reviewed and undone.

## 8. Optional: parallel sessions

When you are comfortable with one session, you can let one pi session coordinate several others working in parallel, each on its own issue or goal:

```sh
cd ~/pi-setup && ./install.sh lanes
```

It asks which repositories and issues or goals to work on, prepares a separate working copy for each, and offers to open the coordinating session. Nothing starts until you run this.

## If something goes wrong

- **`command not found` after step 4:** quit Terminal completely (`⌘ Q`), open it again and retry. If it still fails, run step 4 again, then `cd ~/pi-setup && ./install.sh --with lanes`.
- Run `cd ~/pi-setup && ./install.sh doctor`. It tells you what is missing and how to fix it.
- Re-running `./install.sh --with lanes` is always safe: it continues where it stopped.
- The installer writes a log to `~/.local/state/pi-setup/install.log`. Send it, together with the doctor output, to whoever shared this guide with you.

## Update later

```sh
cd ~/pi-setup && ./install.sh update
```

## Remove it again

```sh
cd ~/pi-setup && ./install.sh uninstall
```

This removes the setup's files and restores anything it replaced. Homebrew, Node.js and pi stay installed; remove pi with `npm uninstall -g @earendil-works/pi-coding-agent` if you want.

More detail: [README](README.md).

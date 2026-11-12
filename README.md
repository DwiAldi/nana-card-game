# NANA Online Board Game

An English-only online multiplayer card game with a local single-player mode against bots.

Repository: [DwiAldi/nana-card-game](https://github.com/DwiAldi/nana-card-game).

![NANA game screenshot](public/img/example.png)

The upstream demo is available at [https://nana.cyron.site](https://nana.cyron.site).

It supports creating rooms and joining others' rooms.

This website is hosted on `Vercel`, made with `NextJS` and `Framer motion`, and uses `Redis` to store server states.

## Development Roadmap

You are welcome to join in developing more features, and submitting issues to help improve the project.

- [x] Multiplayer online play
- [x] Sound effects
- [x] English-only interface
- [ ] Adaptation for small screens
- [ ] Seat layout optimization for different number of players
- [ ] Scoreboard
- [ ] Progressive Web App (PWA) mode
- [ ] Share players' mouse using WebRTC
- [ ] Find a free WebSocket server
- [ ] More attractive animations
- [ ] More appealing UI

## Local Development

```bash
npm install

npm run dev
```

Visit http://localhost:2333 in your browser.

## Disclaimer

Based on [Cyronlee/nana-card-game](https://github.com/Cyronlee/nana-card-game). Thanks to the upstream author and contributors for the original game implementation.

This project is solely for the purpose of learning and communication of `NextJS` and `Framer motion`.

The card images used in the project are sourced from the internet and should not be used for profit-making activities.

You are also welcome to join in and create unique card UI.

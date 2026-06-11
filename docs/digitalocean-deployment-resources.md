# DigitalOcean Deployment — Learning Resources

Video walkthroughs to get up to speed on DigitalOcean and deploying Node.js apps (relevant background for [DEPLOYMENT.md](../DEPLOYMENT.md)). All under 1 hour.

## 1. How to Deploy a Node.js App to Digital Ocean (Nginx, Ubuntu)
https://www.youtube.com/watch?v=bBA2yCnEf68

Closest match to this project's setup: Ubuntu droplet, PM2, Nginx reverse proxy, plus HTTPS via Let's Encrypt — useful since production runs behind `https://backend.auxhr.com`.

**Recommended starting point.**

## 2. Part 2: Deploy Node.js App To DigitalOcean Server (DigitalOcean Crash Course)
https://www.youtube.com/watch?v=akEfQt9oGmc

Beginner-friendly — good for a quick grasp of droplets and SSH basics before getting into PM2 specifics.

## 3. How to Deploy a Node.js App on DigitalOcean App Platform (With CI/CD)
https://www.youtube.com/watch?v=0FpIuKRnQYs

Different approach: managed App Platform instead of a raw droplet + PM2. Useful context if the team ever considers moving away from manual SSH deploys.

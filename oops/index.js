const express = require("express");
const app = express();
const Instagram = require("./app");
const Axios = require("axios");
const Jimp = require("jimp");
const FS = require("fs");
const Cron = require("node-cron");
const Imaps = require("imap-simple");
const _ = require("lodash");
const SimplePaser = require("mailparser").simpleParser;
const Contentful = require("contentful-management");
const Dayjs = require("dayjs");
require("dotenv").config();

//envs
const PORT = process.env.PORT || 8000;
const InstagramUsername = process.env.INSTAGRAM_USERNAME;
const InstagramPassword = process.env.INSTAGRAM_PASSWORD;

Cron.schedule("59 15 * * *", async () => {
  const instagramLoginFunction = async () => {
    const client = new Instagram(
      {
        InstagramUsername,
        InstagramPassword,
      },
      {
        language: "en-US",
        proxy:
          process.env.NODE_ENV === "producation"
            ? process.env.FIXIE_URL
            : undefined,
      }
    );

    const instagramPostPictureFunction = async () => {
      await client
        .getPhotosByUsername({ username: InstagramUsername })
        .then(
          (res) =>
            res.user.edge_owner_to_timeline_media.edges.map(
              (edge) => edge.node.edge_media_to_caption.edges[0].node.text
            )[0]
        )
        .then((mostRecent) => Number(mostRecent.split(" - ")[0]))
        .then((latestNumber) => {
          const updatedNumber = latestNumber + 1;

          const inkyDoodleQuery = `
        query{
        inkDoodleCollection(where: {number: ${updatedNumber}}) {
            items{
                sys{
                    id
                }
                number
                generation
                name
                parents
                imgage{
                    url
                }
            }
        }
        }
        `;

          Axios({
            url: `https://graphql.com/content/space/${process.env.CONTENTFUL_SPACE_ID}`,
            method: "post",
            header: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.CONTENTFUL_ACCESS_TOKEN}`,
            },
            data: {
              query: inkyDoodleQuery,
            },
          })
            .then((res) => res.data)
            .then(({ data, errors }) => {
              if (errors) {
                console.error(errors);
              }
              const updatedInkyDoodle = data.inkDoodleCollection.items[0];
              if (updatedInkyDoodle) {
                const updatedCaption = `${updatedNumber} - ${
                  updatedInkyDoodle.name
                }\n${
                  updatedInkyDoodle.parents
                    ? updatedInkyDoodle.parents.length > 0
                      ? updatedInkyDoodle.parents
                          .map((parent) => "#" + parent)
                          .join(" + ") + " \n"
                      : ""
                    : ""
                }#inkydoodle #gen${updatedInkyDoodle.generation}`;
                Jimp.read(updatedInkyDoodle.image.url).then((lenna) => {
                  return lenna
                    .resize(405, 405, Jimp.RESIZE_NEAREST_NEIGHBOR)
                    .quality(100)
                    .write(`./${updatedInkyDoodle.name}.jpg`, async () => {
                      await client
                        .uploadPhoto({
                          photo: `${updatedInkyDoodle.name}.jpg`,
                          caption: updatedCaption,
                          post: "feed",
                          //if your want to post to your story set the "feed" to "story"
                        })
                        .then(({ media }) => {
                          console.log(
                            `https://www.instagram.com/p/${media.code}`
                          );
                          const contenfulClient = Contentful.createClient({
                            accessToken:
                              process.env.CONTENTFUL_MANAGEMENT_TOKEN,
                          });
                          contenfulClient
                            .getSpace(process.env.CONTENTFUL_SPACE_ID)
                            .then((space) => {
                              space
                                .getEnvironment("master")
                                .then((environment) => {
                                  environment
                                    .getEntry(updatedInkyDoodle.sys.id)
                                    .then((entry) => {
                                      entry.fields.instagram = {
                                        "en-US": {
                                          url: `https://www.instagram.com/p/${media.code}`,
                                          date: Dayjs().format("MMM D, YYY"),
                                        },
                                      };
                                    });
                                });
                            });
                          FS.unlinkSync(`${updatedInkyDoodle.name}.jpg`);
                        });
                    })
                    .catch((err) => console.log(err));
                });
              }
            });
        });
    };

    try {
      console.log("Logging in...");
      await client.login();
      console.log("Login successful");

      const delayedInstagramPostFunction = (timeout) => {
        setTimeout(async () => {
          await instagramPostPictureFunction();
        }, timeout);
      };
      await instagramPostPictureFunction(55000);
    } catch (err) {
      console.log("Login Failed");
      if (err.status === 500) {
        console.log("Throttled");
        return;
      }
      console.log(err.error);
      if (err.error && err.error.message === "checkpoint_required") {
        const challengeUrl = err.error.checkpoint_url;
        await client.updateChallenge({ challengeUrl, choice: 1 });
        const emailConfig = {
          imap: {
            user: `${process.env.USER_EMAIL}`,
            password: `${process.env.USER_PASSWORD}`,
            host: "imap.gmail.com",
            port: 993,
            tls: true,
            tlsOptions: {
              servername: "imap.gmail.com",
              rejectUnauthorized: "false",
            },
            authTimeout: 30000,
          },
        };

        const delayedEmailFunction = async (timeout) => {
          setTimeout(() => {
            Imaps.connect(emailConfig).then(async (connection) => {
              return connection.openBox("INBOX").then(() => {
                const delay = 1 * 3600 * 100;
                let lastHour = new Date();
                lastHour.setTime(Date.now() - delay);
                lastHour = lastHour.toISOString();
                const searchCriteria = ["ALL", "SINCE", lastHour];
                const fetchOptions = {
                  bodies: [""],
                };
                return connection
                  .search(searchCriteria, fetchOptions)
                  .then((messages) => {
                    messages.forEach((item) => {
                      const all = _.find(item.parts, { which: "" });
                      const id = item.attributes.uid;
                      const idHeader = "Imap-Id: " + id + "\r\n";
                      SimplePaser(idHeader + all.body, async (err, mail) => {
                        if (err) {
                          console.log(err);
                        }
                        console.log(mail.subject);
                        const answerCodeArr = mail.text
                          .split("\n")
                          .filter(
                            (item) => item && /^\s*$/.test(item) && !isNaN(item)
                          );
                        if (mail.text.includes("instagram")) {
                          if (answerCodeArr.length > 0) {
                            const answerCode = answerCodeArr[0];
                            console.log(answerCode);

                            await client.updateChallenge({
                              challengeUrl,
                              securityCode: answerCode,
                            });
                            console.log(
                              `Answered Instagram security challenge with answer code: ${answerCode}`
                            );
                            await client.login();
                            await instagramPostPictureFunction();
                          }
                        }
                      });
                    });
                  });
              });
            });
          }, timeout);
        };
        await delayedEmailFunction(45000);
      }
    }
  };
  await instagramLoginFunction();
});

app.listen(PORT, console.log(`App Runing on Port ${PORT}`));

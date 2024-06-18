# 1. Use the official Node.js image as the base image with Node.js version 18
FROM node:18

# 2. Set the working directory inside the container
WORKDIR /app

# 3. Copy the package.json and package-lock.json files to the working directory
COPY package*.json ./

# 4. Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-pip

# 5. Install the dependencies specified in package.json
RUN npm install

# 6. Copy the rest of the application code to the working directory
COPY . .

# 7. Expose the port the app runs on (adjust if your server runs on a different port)
EXPOSE 8080

# 8. Define the command to run the application
CMD ["node", "server.js"]
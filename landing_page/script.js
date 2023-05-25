function randomBackgroundImage(){
    api="https://pixabay.com/api/videos/";
    key="36753244-a5195eb0d0e54d5f267ca2d10";
    q="technology+background";
    lang="en";
    video="animation"
    url=api
    +"?key="+key
    +"&lang="+lang
    +"&video_type="+video
    +"&q="+q;
    fetch(url)
        .then(resp => resp.json())
        .then((data) => {
            maxPage=data.totalHits/20;
            page=Math.floor(Math.random() * (maxPage+1));
            id=Math.floor(Math.random() * 21);
            fetch(url+"&page="+page)
                .then(response => response.json())
                .then((videoResponse) => {
                    video=videoResponse.hits[id].videos.large.url;
                    console.log(video);
                    document.getElementById("randomVideo").src = video;
                })
        })
        .catch(error => {console.log(error)});


}